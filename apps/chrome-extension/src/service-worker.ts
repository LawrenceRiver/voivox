import { getBridgeConfig, getCaptureState, saveCaptureState } from './bridge.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'service-worker' || message?.type !== 'capture:toggle') {
    return;
  }

  void toggleCapture().then(sendResponse).catch(async (error: unknown) => {
    const current = await getCaptureState();
    const response = {
      ...current,
      active: current.active,
      error: error instanceof Error ? error.message : '无法开始标签页收录。'
    };
    await saveCaptureState(response);
    sendResponse(response);
  });
  return true;
});

async function toggleCapture(): Promise<{ active: boolean; tabTitle?: string; error?: string }> {
  const current = await getCaptureState();
  if (current.active) {
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio:stop' }) as { ok?: boolean; error?: string };
    if (!response?.ok) {
      throw new Error(response?.error ?? '桌面 VOIVOX 没有确认停止收录。');
    }
    const stopped = { active: false };
    await saveCaptureState(stopped);
    return stopped;
  }

  const bridge = await getBridgeConfig();
  if (!bridge) {
    throw new Error('先在“连接本机 App”中保存桌面 VOIVOX 的桥接信息。');
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('没有找到当前标签页。');
  }

  await ensureOffscreenDocument();
  const streamId = await getMediaStreamId(tab.id);
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'audio:start',
    bridge,
    streamId,
    tabTitle: tab.title ?? '当前 Chrome 标签页'
  }) as { sessionId?: string; error?: string };

  if (!response.sessionId) {
    throw new Error(response.error ?? '桌面 VOIVOX 没有启动标签页收录。');
  }

  const started = { active: true, sessionId: response.sessionId, tabTitle: tab.title ?? '当前 Chrome 标签页' };
  await saveCaptureState(started);
  return started;
}

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Capture an explicitly selected Chrome tab and forward audio to the local VOIVOX app.'
  });
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
