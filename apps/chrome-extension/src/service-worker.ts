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

let operationTail: Promise<void> = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'service-worker') {
    return;
  }

  if (message.type === 'overlay:show') {
    void showOverlayInCurrentTab()
      .then((shown) => sendResponse({ shown }))
      .catch((error: unknown) => sendResponse({
        error: error instanceof Error ? error.message : '无法在当前网页显示 Voice Vac。'
      }));
    return true;
  }

  if (message.type === 'target:ready') {
    void registerTargetSession(message, sender.tab?.id).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'target:preview') {
    void previewTargetSession(message, sender.tab?.id).then(() => sendResponse({ ok: true }));
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

async function persistOffscreenCaptureState(value: unknown): Promise<CaptureState> {
  const state = normalizeCaptureState(value);
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

async function registerTargetSession(message: Record<string, unknown>, tabId: number | undefined): Promise<void> {
  const current = await getCaptureState();
  const next: CaptureState = {
    ...current,
    linkState: 'ready',
    targetRect: isTunnelRect(message.targetRect) ? message.targetRect : current.targetRect,
    pageEndpoint: isTunnelPoint(message.pageEndpoint) ? message.pageEndpoint : current.pageEndpoint,
    tabTitle: typeof message.tabTitle === 'string' ? message.tabTitle : current.tabTitle,
    tabUrl: typeof message.url === 'string' ? message.url : current.tabUrl
  };
  if (tabId !== undefined) {
    const discovery = await discoverNativeDesktop();
    next.tunnelSessionId = await syncTunnelSession({
      discovery,
      pageEndpoint: next.pageEndpoint,
      state: 'ready',
      tabId,
      targetRect: next.targetRect,
      title: next.tabTitle,
      url: next.tabUrl
    });
  }
  await saveCaptureState(next);
}

async function previewTargetSession(message: Record<string, unknown>, tabId: number | undefined): Promise<void> {
  const current = await getCaptureState();
  const next: CaptureState = {
    ...current,
    linkState: 'detecting',
    targetRect: isTunnelRect(message.targetRect) ? message.targetRect : current.targetRect,
    pageEndpoint: isTunnelPoint(message.pageEndpoint) ? message.pageEndpoint : current.pageEndpoint
  };
  if (current.tunnelSessionId && tabId !== undefined) {
    const discovery = await discoverNativeDesktop();
    await syncTunnelSession({
      discovery,
      pageEndpoint: next.pageEndpoint,
      sessionId: current.tunnelSessionId,
      state: 'detecting',
      tabId,
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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('没有找到当前标签页。');
  }

  await ensureOffscreenDocument();
  const streamId = await getMediaStreamId(tab.id);
  const bridge: BridgeConfig | undefined = desktop.source === 'native-messaging'
    ? { baseUrl: desktop.baseUrl, token: desktop.token }
    : undefined;
  const response = await chrome.runtime.sendMessage({
    bridge,
    mode,
    route,
    streamId,
    tabTitle: tab.title ?? '当前 Chrome 标签页',
    tabUrl: tab.url,
    target: 'offscreen',
    type: 'audio:start'
  }) as { error?: string; sessionId?: string };

  if (!response.sessionId) {
    throw new Error(response.error ?? '无法开始标签页静音收录。');
  }
  const next = await getCaptureState();
  if (next.active || next.phase === 'capturing') {
    await saveCaptureState({ ...next, linkState: 'transcribing' });
  }
  return getCaptureState();
}

export async function showOverlayInCurrentTab(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return false;
  await chrome.scripting.executeScript({
    files: ['content-tunnel.js'],
    target: { tabId: tab.id }
  });
  return true;
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
