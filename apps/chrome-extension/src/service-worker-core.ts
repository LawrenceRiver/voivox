import {
  getCaptureState,
  normalizeCaptureState,
  saveCaptureState,
  type BridgeConfig,
  type CaptureState
} from './bridge.js';
import { chooseTranscriptionRoute, type TranscriptionMode } from './local-transcription.js';
import { discoverNativeDesktop } from './native-discovery.js';
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

export type ServiceWorkerRuntimeOptions = {
  channel: 'store' | 'automation';
};

export function createServiceWorkerRuntime(options: ServiceWorkerRuntimeOptions): void {
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
      const response: CaptureState = {
        ...current,
        error: error instanceof Error ? error.message : '无法完成这次本地转写。',
        errorCode: undefined,
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

async function startCapture(mode: TranscriptionMode): Promise<CaptureState> {
  const desktop = await discoverNativeDesktop();
  const route = chooseTranscriptionRoute(desktop, true);
  if (route === 'unavailable') {
    throw new Error('此浏览器无法运行本地转写模型。');
  }

  const targetSession = await targetSessionStore.get();
  if (!targetSession) throw new TabArmError('TAB_NOT_ARMED', 'The selected Chrome tab is not armed.');

  await ensureOffscreenDocument();
  const streamId = await getMediaStreamId(targetSession.tabId);
  const bridge: BridgeConfig | undefined = desktop.source === 'native-messaging'
    ? { baseUrl: desktop.baseUrl, token: desktop.token }
    : undefined;
  acceptingCaptureStart = true;
  let response: { error?: string; sessionId?: string };
  try {
    response = await chrome.runtime.sendMessage({
      bridge,
      mode,
      route,
      streamId,
      tabTitle: targetSession.title,
      tabUrl: targetSession.url,
      target: 'offscreen',
      type: 'audio:start'
    }) as { error?: string; sessionId?: string };
  } finally {
    acceptingCaptureStart = false;
  }

  if (!response.sessionId) {
    throw new Error(response.error ?? '无法开始标签页静音收录。');
  }
  const next = await getCaptureState();
  if (next.active || next.phase === 'capturing') {
    await saveCaptureState({ ...next, linkState: 'transcribing' });
  }
  return getCaptureState();
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
    return acceptingCaptureStart && incoming.active && incoming.phase === 'capturing';
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
  if (!current.canRetry || current.route !== 'browser-local') {
    return current;
  }
  const wasCreated = await ensureOffscreenDocument();
  if (wasCreated) {
    return markBrowserBufferLost(current);
  }
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio:retry' }) as {
    error?: string;
    state?: CaptureState;
  };
  if (!response.state) {
    throw new Error(response.error ?? '没有可重试的本地音频。');
  }
  return getCaptureState();
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
    error: '浏览器已回收上次的本地音频缓冲，请重新开始收录。',
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
    justification: 'Capture an explicitly selected tab and run Voice Vac local speech recognition.'
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
