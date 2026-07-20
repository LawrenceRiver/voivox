import {
  getCaptureState,
  normalizeCaptureState,
  saveCaptureState,
  type BridgeConfig,
  type CaptureState
} from './bridge.js';
import {
  normalizeCaptureErrorCode,
  type CaptureErrorCode
} from './capture-errors.js';
import { chooseTranscriptionRoute, type TranscriptionMode } from './local-transcription.js';
import { discoverNativeDesktop } from './native-discovery.js';
import {
  createNativeCommandChannel,
  type NativeCommand,
  type NativeCommandChannel
} from './native-command-channel.js';
import type { PlaybackDriver } from './playback-driver.js';
import { StorePlaybackDriver } from './store-playback-driver.js';
import { syncTunnelSession } from './tunnel-session-sync.js';
import {
  armActiveTab,
  registerTargetLifecycle,
  TabArmError,
  type TargetInvalidationCode
} from './tab-arm.js';
import { TargetSessionStore, validateSessionSender } from './target-session-store.js';
import type { TargetSession } from './target-session.js';

let operationTail: Promise<void> = Promise.resolve();
let acceptingCaptureStart = false;
const targetSessionStore = new TargetSessionStore();
let playbackDriver: PlaybackDriver | undefined;
let nativeCommandChannel: NativeCommandChannel | undefined;
const MAXIMUM_COMMAND_AGE_MS = 2 * 60_000;
const MAXIMUM_COMMAND_FUTURE_MS = 30_000;

class CaptureOperationError extends Error {
  constructor(
    message: string,
    readonly code?: CaptureErrorCode,
    readonly retryable?: boolean
  ) {
    super(message);
    this.name = 'CaptureOperationError';
  }
}

export type ServiceWorkerRuntimeOptions = {
  channel: 'store' | 'automation';
  createPlaybackDriver?: () => PlaybackDriver;
};

export function createServiceWorkerRuntime(options: ServiceWorkerRuntimeOptions): void {
  playbackDriver = options.createPlaybackDriver?.() ?? new StorePlaybackDriver();
  if (options.channel === 'automation' && !options.createPlaybackDriver) {
    throw new Error('Voice VAC Automation requires its injected playback driver.');
  }
  if (typeof chrome.runtime.connectNative === 'function') {
    nativeCommandChannel = createNativeCommandChannel({
      connectNative: (host) => chrome.runtime.connectNative(host),
      dispatch: dispatchNativeCommand,
      onDispatchError: (error) => { void publishCommandFailure(error); }
    });
    nativeCommandChannel.start();
  }
  registerRuntimeMessages(options);
  registerTargetLifecycle({
    tabs: chrome.tabs,
    sessionStore: targetSessionStore,
    stopSession: stopInvalidatedSession,
    disposePlayback: disposePlaybackForReplacement,
    publishError: publishTargetInvalidation
  });
}

function registerRuntimeMessages(_options: ServiceWorkerRuntimeOptions): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'service-worker') {
    return;
  }

  if (message.type === 'tab:arm') {
    void serializeOperation(armCurrentDocument)
      .then(sendResponse)
      .catch(async (error: unknown) => {
        const state = await publishArmFailure(error);
        sendResponse({ captureState: state, error: armErrorCode(error) });
      });
    return true;
  }

  if (message.type === 'target:ready') {
    void registerTargetSession(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse(targetMessageFailure(error)));
    return true;
  }

  if (message.type === 'target:preview') {
    void previewTargetSession(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) => sendResponse(targetMessageFailure(error)));
    return true;
  }

  if (message.type === 'playback:user-started' || message.type === 'playback:ended') {
    void serializeOperation(async () => {
      await handlePlaybackMessage(message, sender);
      return getCaptureState();
    })
      .then(sendResponse)
      .catch((error: unknown) => sendResponse({
        error: error instanceof Error ? error.message : 'Voice VAC playback could not be controlled.'
      }));
    return true;
  }

  if (message.type === 'capture-state:get' || message.type === 'capture-state:save') {
    const stateWork = message.type === 'capture-state:get'
      ? getCaptureState()
      : persistOffscreenCaptureState(message.state);
    void stateWork.then(sendResponse).catch((error: unknown) => {
      sendResponse({
        active: false,
        error: error instanceof Error ? error.message : '无法读写扩展本地状态。',
        mode: 'quality',
        phase: 'error'
      } satisfies CaptureState);
    });
    return true;
  }

  const operation = message.type === 'capture:toggle'
    ? () => toggleCapture()
    : message.type === 'capture:retry'
      ? () => retryTranscription()
      : message.type === 'mode:set'
        ? () => setMode(message.mode)
        : undefined;
  if (!operation) {
    return;
  }

  const work = serializeOperation(async () => {
    try {
      return await operation();
    } catch (error) {
      const current = await getCaptureState();
      const failure = error instanceof CaptureOperationError ? error : undefined;
      const response: CaptureState = {
        ...current,
        active: false,
        ...(typeof failure?.retryable === 'boolean' ? { canRetry: failure.retryable } : {}),
        error: error instanceof Error ? error.message : '无法完成这次本地转写。',
        errorCode: failure?.code,
        phase: 'error'
      };
      await saveCaptureState(response);
      return response;
    }
  });
  void work.then(sendResponse).catch((error: unknown) => {
    sendResponse({
      active: false,
      error: error instanceof Error ? error.message : '无法读写扩展本地状态。',
      mode: 'quality',
      phase: 'error'
    } satisfies CaptureState);
  });
  return true;
  });
}

async function persistOffscreenCaptureState(value: unknown): Promise<CaptureState> {
  const state = normalizeCaptureState(value);
  const current = await getCaptureState();
  if (!canAcceptOffscreenState(current, state)) return current;
  if (state.phase === 'complete') state.linkState = 'completed';
  if (state.phase === 'error') state.linkState = 'error';
  if (state.phase === 'transcribing' || state.phase === 'downloading') state.linkState = 'transcribing';
  if (state.phase === 'paused') state.linkState = 'paused';
  if (state.phase === 'idle' && !state.tunnelSessionId) state.linkState = 'idle';
  if (state.tunnelSessionId) {
    const discovery = await discoverNativeDesktop();
    await syncTunnelSession({ discovery, sessionId: state.tunnelSessionId, state: state.linkState, tabId: 0 });
  }
  await saveCaptureState(state);
  return state;
}

async function registerTargetSession(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender
): Promise<void> {
  const targetSession = await targetSessionStore.get();
  if (!targetSession || !validateSessionSender(targetSession, sender)) {
    throw new TabArmError('TARGET_NAVIGATED', 'The armed page navigated. Arm the current page again.');
  }
  const current = await getCaptureState();
  const next: CaptureState = {
    ...current,
    linkState: 'ready',
    targetRect: isTunnelRect(message.targetRect) ? message.targetRect : current.targetRect,
    pageEndpoint: isTunnelPoint(message.pageEndpoint) ? message.pageEndpoint : current.pageEndpoint,
    tabTitle: typeof message.tabTitle === 'string' ? message.tabTitle : current.tabTitle,
    tabUrl: typeof message.url === 'string' ? message.url : current.tabUrl
  };
  if (targetSession.tunnelSessionId) {
    const discovery = await discoverNativeDesktop();
    await syncTunnelSession({
      discovery,
      pageEndpoint: next.pageEndpoint,
      sessionId: targetSession.tunnelSessionId,
      state: 'ready',
      tabId: targetSession.tabId,
      targetRect: next.targetRect,
      title: next.tabTitle
    });
    next.tunnelSessionId = targetSession.tunnelSessionId;
  }
  await saveCaptureState(next);
}

async function previewTargetSession(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender
): Promise<void> {
  const targetSession = await targetSessionStore.get();
  if (!targetSession || !validateSessionSender(targetSession, sender)) {
    throw new TabArmError('TARGET_NAVIGATED', 'The armed page navigated. Arm the current page again.');
  }
  const current = await getCaptureState();
  const next: CaptureState = {
    ...current,
    linkState: 'detecting',
    targetRect: isTunnelRect(message.targetRect) ? message.targetRect : current.targetRect,
    pageEndpoint: isTunnelPoint(message.pageEndpoint) ? message.pageEndpoint : current.pageEndpoint
  };
  if (targetSession.tunnelSessionId) {
    const discovery = await discoverNativeDesktop();
    await syncTunnelSession({
      discovery,
      pageEndpoint: next.pageEndpoint,
      sessionId: targetSession.tunnelSessionId,
      state: 'detecting',
      tabId: targetSession.tabId,
      targetRect: next.targetRect
    });
  }
  await saveCaptureState(next);
}

async function toggleCapture(): Promise<CaptureState> {
  const current = await getCaptureState();
  if (current.active) {
    if (!await hasOffscreenDocument()) {
      return recoverLostCapture(current);
    }
    let response: { error?: string; state?: CaptureState };
    try {
      response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio:stop' }) as {
        error?: string;
        state?: CaptureState;
      };
    } catch (error) {
      if (!await hasOffscreenDocument()) {
        return recoverLostCapture(current);
      }
      throw error;
    }
    if (!response?.state) {
      throw new Error(response?.error ?? 'Voice Vac 没有确认停止收录。');
    }
    return getCaptureState();
  }
  if (current.phase === 'downloading' || current.phase === 'transcribing') {
    return cancelTranscription(current);
  }
  return startCapture(current.mode);
}

async function cancelTranscription(current: CaptureState): Promise<CaptureState> {
  if (!await hasOffscreenDocument()) {
    return markBrowserBufferLost(current);
  }
  let response: { error?: string; state?: CaptureState };
  try {
    response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio:cancel' }) as {
      error?: string;
      state?: CaptureState;
    };
  } catch (error) {
    if (!await hasOffscreenDocument()) {
      return markBrowserBufferLost(current);
    }
    throw error;
  }
  if (!response.state) {
    throw new Error(response.error ?? 'Voice Vac 没有确认取消转写。');
  }
  return getCaptureState();
}

async function startCapture(mode: TranscriptionMode, jobId?: string): Promise<CaptureState> {
  const desktop = await discoverNativeDesktop();
  const route = chooseTranscriptionRoute(desktop);
  if (route === 'unavailable') {
    if (desktop.source === 'native-messaging' && desktop.localAsr === 'missing') {
      throw new CaptureOperationError(
        'The local Qwen3-ASR model is not installed.',
        'ASR_MODEL_MISSING',
        false
      );
    }
    throw new CaptureOperationError(
      'Open the Voice VAC App before starting local transcription.',
      'NATIVE_HOST_UNAVAILABLE',
      true
    );
  }
  if (desktop.source !== 'native-messaging') {
    throw new Error('Open the Voice VAC App before starting local transcription.');
  }

  const targetSession = await targetSessionStore.get();
  if (!targetSession) throw new TabArmError('TAB_NOT_ARMED', 'The selected Chrome tab is not armed.');
  if (!targetSession.tunnelSessionId) {
    throw new Error('Reconnect this armed tab to the Voice VAC App before starting.');
  }

  await ensureOffscreenDocument();
  const streamId = await getMediaStreamId(targetSession.tabId);
  const bridge: BridgeConfig = { baseUrl: desktop.baseUrl, token: desktop.token };
  acceptingCaptureStart = true;
  let response: { error?: string; errorCode?: string; retryable?: boolean; sessionId?: string };
  try {
    response = await chrome.runtime.sendMessage({
      bridge,
      ...(jobId ? { jobId } : {}),
      mode,
      route,
      streamId,
      tabTitle: targetSession.title,
      tabUrl: targetSession.url,
      target: 'offscreen',
      tunnelSessionId: targetSession.tunnelSessionId,
      type: 'audio:start'
    }) as { error?: string; errorCode?: string; retryable?: boolean; sessionId?: string };
  } finally {
    acceptingCaptureStart = false;
  }

  if (!response.sessionId) {
    throw new CaptureOperationError(
      response.error ?? '无法开始标签页静音收录。',
      normalizeCaptureErrorCode(response.errorCode),
      typeof response.retryable === 'boolean' ? response.retryable : undefined
    );
  }
  const next = await getCaptureState();
  if (next.active || next.phase === 'capturing') {
    await saveCaptureState({ ...next, linkState: 'transcribing' });
  }
  return getCaptureState();
}

async function dispatchNativeCommand(command: NativeCommand): Promise<void> {
  const age = Date.now() - command.issuedAt;
  if (age > MAXIMUM_COMMAND_AGE_MS || age < -MAXIMUM_COMMAND_FUTURE_MS) return;
  const targetSession = await targetSessionStore.get();
  if (!targetSession || targetSession.id !== command.sessionId) {
    throw new CaptureOperationError('The native command target is no longer armed.', 'TAB_NOT_ARMED', true);
  }

  switch (command.type) {
    case 'drag-begin':
      await sendTargetMessage(targetSession, {
        dropToken: targetSession.dropToken,
        sessionId: targetSession.id,
        type: 'drag:begin'
      });
      return;
    case 'drag-cancel':
      await sendTargetMessage(targetSession, { sessionId: targetSession.id, type: 'drag:cancel' });
      return;
    case 'capture-start':
      await dispatchCaptureStart(targetSession, command.commandId);
      return;
    case 'capture-pause':
      await dispatchCapturePause(targetSession);
      return;
    case 'capture-resume':
      await dispatchCaptureResume(targetSession);
      return;
    case 'capture-stop':
      await dispatchCaptureStop(targetSession);
      return;
    case 'target-disconnect':
      await dispatchTargetDisconnect(targetSession);
      return;
  }
}

async function dispatchCaptureStart(targetSession: TargetSession, jobId: string): Promise<void> {
  const current = await getCaptureState();
  if (isActiveCaptureState(current)) {
    if (current.tunnelSessionId === targetSession.tunnelSessionId) return;
    throw new CaptureOperationError('Voice VAC is already capturing another target.', 'STREAM_ENDED', true);
  }
  await startCapture(current.mode, jobId);
  const driver = requirePlaybackDriver();
  const result = await driver.play(targetSession);
  if (result.status === 'user-play-required') {
    const waiting = await getCaptureState();
    await saveCaptureState({ ...waiting, phase: 'awaiting-user-play', linkState: 'transcribing' });
    return;
  }
  if (result.status === 'failed') {
    await stopCaptureAfterPlaybackFailure(result.code);
    throw new CaptureOperationError('Voice VAC could not start the selected video.', result.code, true);
  }
}

async function dispatchCapturePause(targetSession: TargetSession): Promise<void> {
  const current = await getCaptureState();
  if (!isActiveCaptureState(current)) return;
  await requirePlaybackDriver().pause(targetSession);
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio:pause' }) as {
    error?: string;
    state?: CaptureState;
  };
  if (!response.state) throw new Error(response.error ?? 'Voice VAC could not pause the capture.');
}

async function dispatchCaptureResume(targetSession: TargetSession): Promise<void> {
  const current = await getCaptureState();
  if (current.phase !== 'paused') return;
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio:resume' }) as {
    error?: string;
    state?: CaptureState;
  };
  if (!response.state) throw new Error(response.error ?? 'Voice VAC could not resume the capture.');
  const result = await requirePlaybackDriver().play(targetSession);
  if (result.status === 'failed') throw new CaptureOperationError(
    'Voice VAC could not resume the selected video.', result.code, true
  );
}

async function dispatchCaptureStop(targetSession: TargetSession): Promise<void> {
  const current = await getCaptureState();
  if (!isActiveCaptureState(current)) return;
  await requirePlaybackDriver().pause(targetSession).catch(() => undefined);
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio:stop' }) as {
    error?: string;
    state?: CaptureState;
  };
  if (!response.state) throw new Error(response.error ?? 'Voice VAC could not stop the capture.');
}

async function dispatchTargetDisconnect(targetSession: TargetSession): Promise<void> {
  const current = await getCaptureState();
  if (isActiveCaptureState(current)) await dispatchCaptureStop(targetSession);
  await requirePlaybackDriver().dispose(targetSession);
  await sendTargetMessage(targetSession, { sessionId: targetSession.id, type: 'target-disconnect' });
}

async function stopCaptureAfterPlaybackFailure(code: CaptureErrorCode): Promise<void> {
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio:cancel' }) as {
    state?: CaptureState;
  };
  if (!response.state) return;
  const current = await getCaptureState();
  await saveCaptureState({
    ...current,
    active: false,
    canRetry: true,
    error: 'Voice VAC could not start the selected video.',
    errorCode: code,
    phase: 'error'
  });
}

async function handlePlaybackMessage(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender
): Promise<void> {
  const targetSession = await targetSessionStore.get();
  if (!targetSession || typeof message.sessionId !== 'string'
    || message.sessionId !== targetSession.id
    || !validateSessionSender(targetSession, sender)) return;
  if (message.type === 'playback:ended') {
    await dispatchCaptureStop(targetSession);
    return;
  }
  const current = await getCaptureState();
  if (isActiveCaptureState(current)) {
    const result = await requirePlaybackDriver().play(targetSession);
    if (result.status === 'failed') {
      throw new CaptureOperationError('Voice VAC could not start the selected video.', result.code, true);
    }
    if (result.status === 'playing') {
      await saveCaptureState({ ...current, active: true, phase: 'capturing', linkState: 'transcribing' });
    }
  }
}

async function sendTargetMessage(targetSession: TargetSession, message: Record<string, unknown>): Promise<unknown> {
  return chrome.tabs.sendMessage(targetSession.tabId, message, {
    documentId: targetSession.documentId,
    frameId: targetSession.frameId
  });
}

function requirePlaybackDriver(): PlaybackDriver {
  if (!playbackDriver) throw new CaptureOperationError(
    'Voice VAC playback is not ready.',
    'EXTENSION_UNAVAILABLE',
    true
  );
  return playbackDriver;
}

async function publishCommandFailure(error: unknown): Promise<void> {
  const current = await getCaptureState().catch(() => undefined);
  if (!current) return;
  const failure = error instanceof CaptureOperationError ? error : undefined;
  await saveCaptureState({
    ...current,
    active: false,
    canRetry: failure?.retryable ?? true,
    error: error instanceof Error ? error.message : 'Voice VAC command failed.',
    ...(failure?.code ? { errorCode: failure.code } : {}),
    phase: 'error'
  }).catch(() => undefined);
}

async function armCurrentDocument(): Promise<{
  captureState: CaptureState;
  session: TargetSession;
}> {
  await retryDetachedDesktopTunnel();
  const session = await armActiveTab({
    tabs: chrome.tabs,
    scripting: chrome.scripting,
    sessionStore: targetSessionStore,
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    beforeReplace: replaceArmedSession
  });
  const current = await getCaptureState();
  const discovery = await discoverNativeDesktop();
  const tunnelSessionId = await syncTunnelSession({
    discovery,
    tabId: session.tabId,
    frameId: session.frameId,
    documentId: session.documentId,
    dropToken: session.dropToken,
    state: 'idle',
    title: session.title,
    url: session.url
  });
  const storedSession = tunnelSessionId
    ? await targetSessionStore.update(session.id, { tunnelSessionId })
    : session;
  const captureState = normalizeCaptureState({
    ...current,
    active: false,
    canRetry: undefined,
    error: undefined,
    errorCode: undefined,
    linkState: 'idle',
    phase: 'armed',
    progress: undefined,
    route: undefined,
    sessionId: undefined,
    tabTitle: storedSession.title,
    tabUrl: storedSession.url,
    transcript: undefined,
    ...(tunnelSessionId ? { tunnelSessionId } : {})
  });
  await saveCaptureState(captureState);
  return { captureState, session: storedSession };
}

async function stopInvalidatedSession(_session: TargetSession): Promise<void> {
  await stopSessionForReplacement();
}

async function replaceArmedSession(previous: TargetSession): Promise<void> {
  await stopSessionForReplacement();
  await disposePlaybackForReplacement(previous);
  await terminateDesktopTunnel(previous, true);
}

async function stopSessionForReplacement(): Promise<void> {
  const current = await getCaptureState();
  const requiresStop = current.active
    || current.phase === 'capturing'
    || current.phase === 'paused'
    || current.phase === 'downloading'
    || current.phase === 'transcribing';
  const hasOffscreen = await hasOffscreenDocument();
  if (!hasOffscreen) {
    if (requiresStop) throw new Error('The previous Voice VAC capture could not be drained.');
    return;
  }
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio:stop' }) as {
    state?: CaptureState;
  };
  if (!response?.state) throw new Error('The previous Voice VAC capture did not confirm stop.');
  let stopped = normalizeCaptureState(response.state);
  if (!stopped.active && (stopped.phase === 'downloading' || stopped.phase === 'transcribing')) {
    const cancelled = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio:cancel' }) as {
      state?: CaptureState;
    };
    if (!cancelled?.state) throw new Error('The previous Voice VAC transcription did not confirm cancellation.');
    stopped = normalizeCaptureState(cancelled.state);
  }
  if (isActiveCaptureState(stopped)) {
    throw new Error('The previous Voice VAC capture is still active after stop.');
  }
}

async function disposePlaybackForReplacement(session: TargetSession): Promise<void> {
  await chrome.tabs.sendMessage(
    session.tabId,
    { sessionId: session.id, type: 'target-disconnect' },
    { documentId: session.documentId, frameId: session.frameId }
  );
}

async function terminateDesktopTunnel(
  session: TargetSession,
  required: boolean,
  errorCode: TargetInvalidationCode = 'TARGET_NAVIGATED'
): Promise<boolean> {
  if (!session.tunnelSessionId) return true;
  const discovery = await discoverNativeDesktop();
  if (discovery.source !== 'native-messaging' || !discovery.reachable) {
    if (required) throw new Error('The previous Voice VAC desktop tunnel could not be terminated.');
    return false;
  }
  const result = await syncTunnelSession({
    discovery,
    errorCode,
    sessionId: session.tunnelSessionId,
    state: 'error',
    tabId: session.tabId
  });
  if (result !== session.tunnelSessionId) {
    if (required) throw new Error('The previous Voice VAC desktop tunnel did not confirm termination.');
    return false;
  }
  return true;
}

async function publishTargetInvalidation(
  code: TargetInvalidationCode,
  session: TargetSession
): Promise<void> {
  const current = await getCaptureState();
  const terminated = await terminateDesktopTunnel(session, false, code);
  const error = code === 'TAB_CLOSED'
    ? 'The armed Chrome tab was closed.'
    : 'The armed page navigated. Arm the current page again.';
  await saveCaptureState({
    ...current,
    active: false,
    canRetry: false,
    error,
    errorCode: code,
    linkState: 'error',
    phase: 'error',
    tabTitle: session.title,
    tabUrl: session.url,
    tunnelSessionId: terminated ? undefined : session.tunnelSessionId
  });
}

async function retryDetachedDesktopTunnel(): Promise<void> {
  if (await targetSessionStore.get()) return;
  const current = await getCaptureState();
  if (!current.tunnelSessionId) return;
  const discovery = await discoverNativeDesktop();
  const result = await syncTunnelSession({
    discovery,
    errorCode: current.errorCode === 'TAB_CLOSED' ? 'TAB_CLOSED' : 'TARGET_NAVIGATED',
    sessionId: current.tunnelSessionId,
    state: 'error'
  });
  if (result !== current.tunnelSessionId) {
    throw new Error('The previous Voice VAC desktop tunnel could not be retried.');
  }
  await saveCaptureState({ ...current, tunnelSessionId: undefined });
}

function canAcceptOffscreenState(current: CaptureState, incoming: CaptureState): boolean {
  if (isLifecycleTerminal(current)) return false;
  if (current.phase === 'armed') {
    return acceptingCaptureStart && (
      (incoming.active && incoming.phase === 'capturing')
      || (!incoming.active && incoming.phase === 'error')
    );
  }
  if (current.sessionId && incoming.sessionId && current.sessionId !== incoming.sessionId) {
    return false;
  }
  return true;
}

function isActiveCaptureState(state: CaptureState): boolean {
  return state.active
    || state.phase === 'capturing'
    || state.phase === 'paused'
    || state.phase === 'awaiting-user-play'
    || state.phase === 'downloading'
    || state.phase === 'transcribing';
}

async function publishArmFailure(error: unknown): Promise<CaptureState> {
  const current = await getCaptureState();
  if (isLifecycleTerminal(current)) return current;
  const next: CaptureState = {
    ...current,
    active: false,
    error: error instanceof Error ? error.message : 'The selected Chrome tab could not be armed.',
    errorCode: undefined,
    linkState: 'error',
    phase: 'error'
  };
  await saveCaptureState(next);
  return next;
}

function isLifecycleTerminal(state: CaptureState): boolean {
  return state.phase === 'error'
    && (state.errorCode === 'TAB_CLOSED' || state.errorCode === 'TARGET_NAVIGATED');
}

function armErrorCode(error: unknown): string {
  return error instanceof TabArmError ? error.code : 'TAB_NOT_ARMED';
}

function targetMessageFailure(error: unknown): {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
} {
  const code = error instanceof TabArmError ? error.code : 'TARGET_NAVIGATED';
  const message = code === 'TAB_NOT_ARMED'
    ? 'The selected Chrome tab is not armed.'
    : 'The armed page navigated. Arm the current page again.';
  return { ok: false, error: { code, message, retryable: true } };
}

async function retryTranscription(): Promise<CaptureState> {
  const current = await getCaptureState();
  if (!current.canRetry || current.route !== 'desktop-local') {
    return current;
  }
  return markBrowserBufferLost(current);
}

async function setMode(value: unknown): Promise<CaptureState> {
  const current = await getCaptureState();
  if (value !== 'fast' && value !== 'quality') {
    throw new Error('不支持这个转写模式。');
  }
  if (current.active || current.phase === 'downloading' || current.phase === 'transcribing') {
    return current;
  }
  const updated: CaptureState = {
    ...current,
    error: undefined,
    errorCode: undefined,
    mode: value
  };
  await saveCaptureState(updated);
  return updated;
}

async function markBrowserBufferLost(current: CaptureState): Promise<CaptureState> {
  const lostBuffer: CaptureState = {
    ...current,
    canRetry: false,
    error: 'Chrome does not retain relayed tab audio. Start a new capture.',
    errorCode: undefined,
    phase: 'error'
  };
  await saveCaptureState(lostBuffer);
  return lostBuffer;
}

async function ensureOffscreenDocument(): Promise<boolean> {
  if (await hasOffscreenDocument()) {
    return false;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Relay one explicitly selected tab audio stream to the local Voice VAC App.'
  });
  return true;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  return contexts.length > 0;
}

async function recoverLostCapture(current: CaptureState): Promise<CaptureState> {
  const recovered: CaptureState = {
    active: false,
    mode: current.mode,
    phase: 'idle'
  };
  await saveCaptureState(recovered);
  return recovered;
}

function serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(() => undefined, () => undefined);
  return result;
}

function getMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(streamId);
    });
  });
}

function isTunnelPoint(value: unknown): value is { screenX: number; screenY: number } {
  return Boolean(value) && typeof value === 'object'
    && Number.isFinite((value as { screenX?: unknown }).screenX)
    && Number.isFinite((value as { screenY?: unknown }).screenY);
}

function isTunnelRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  return Boolean(value) && typeof value === 'object'
    && Number.isFinite((value as { x?: unknown }).x)
    && Number.isFinite((value as { y?: unknown }).y)
    && Number.isFinite((value as { width?: unknown }).width)
    && Number.isFinite((value as { height?: unknown }).height);
}
