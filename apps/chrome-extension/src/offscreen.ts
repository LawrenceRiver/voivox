import { StreamingDownsampler, bytesToBase64, float32ToPcm16 } from './audio-codec.js';
import { getCaptureState, saveCaptureState, type BridgeConfig } from './bridge.js';
import { BoundedAudioQueue } from './pending-audio.js';

let audioContext: AudioContext | undefined;
let audioStream: MediaStream | undefined;
let workletNode: AudioWorkletNode | undefined;
let silentGain: GainNode | undefined;
let sessionId: string | undefined;
let bridge: BridgeConfig | undefined;
let flushWork: Promise<void> | undefined;
let downsampler = new StreamingDownsampler();
const pendingAudio = new BoundedAudioQueue(16_000 * 60);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') {
    return;
  }

  if (message.type === 'audio:start') {
    void startCapture(message).then(sendResponse).catch((error: unknown) => {
      sendResponse({ error: error instanceof Error ? error.message : '无法初始化标签页声音。' });
    });
    return true;
  }

  if (message.type === 'audio:stop') {
    void stopCapture().then(() => sendResponse({ ok: true })).catch((error: unknown) => {
      sendResponse({ error: error instanceof Error ? error.message : '无法停止收录。' });
    });
    return true;
  }
});

async function startCapture(message: {
  bridge: BridgeConfig;
  streamId: string;
  tabTitle: string;
}): Promise<{ sessionId: string }> {
  await stopCapture();
  bridge = message.bridge;
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: message.streamId
        }
      } as MediaTrackConstraints
    });

    const response = await localRequest('/v1/extension/captures', {
      method: 'POST',
      body: JSON.stringify({ source: { kind: 'chrome-tab', label: message.tabTitle } })
    });
    const session = await response.json() as { id: string };
    sessionId = session.id;
    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
    const source = audioContext.createMediaStreamSource(audioStream);
    workletNode = new AudioWorkletNode(audioContext, 'voivox-capture');
    workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => queueAudio(event.data, audioContext?.sampleRate ?? 48_000);
    source.connect(workletNode);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    workletNode.connect(silentGain);
    silentGain.connect(audioContext.destination);
    await audioContext.resume();
    return { sessionId };
  } catch (error) {
    await stopCapture().catch(() => undefined);
    throw error;
  }
}

async function stopCapture(): Promise<void> {
  const currentSession = sessionId;
  const currentBridge = bridge;
  await releaseAudioGraph();
  let failure: Error | undefined;
  try {
    await flushAudio();
  } catch (error) {
    failure = asError(error);
  }

  if (!failure && currentSession && currentBridge) {
    try {
      const response = await fetch(`${currentBridge.baseUrl}/v1/extension/captures/${encodeURIComponent(currentSession)}/stop`, {
        method: 'POST',
        headers: { authorization: `Bearer ${currentBridge.token}` }
      });
      if (!response.ok) {
        throw new Error('桌面 VOIVOX 未能确认停止标签页收录。');
      }
    } catch (error) {
      failure = asError(error);
    }
  }

  if (failure) {
    await reportCaptureError(failure);
    throw failure;
  }

  sessionId = undefined;
  bridge = undefined;
  pendingAudio.clear();
  downsampler.reset();
}

async function releaseAudioGraph(): Promise<void> {
  workletNode?.disconnect();
  workletNode = undefined;
  silentGain?.disconnect();
  silentGain = undefined;
  audioStream?.getTracks().forEach((track) => track.stop());
  audioStream = undefined;
  await audioContext?.close();
  audioContext = undefined;
}

function queueAudio(samples: Float32Array, sourceRate: number): void {
  const wasAccepted = pendingAudio.append(downsampler.resample(samples, sourceRate));
  if (!wasAccepted) {
    void reportCaptureError(new Error('本机连接不可用，VOIVOX 仅保留了最近 60 秒待发送的标签页音频。请恢复桌面 App 后点击停止重试。'));
  }
  if (pendingAudio.size >= 4_000) {
    void flushAudio().catch((error: unknown) => void reportCaptureError(asError(error)));
  }
}

async function flushAudio(): Promise<void> {
  while (true) {
    if (flushWork) {
      await flushWork;
      continue;
    }
    if (!sessionId || pendingAudio.size === 0) {
      return;
    }
    const pending = pendingAudio.take();
    const work = localRequest(`/v1/extension/captures/${encodeURIComponent(sessionId)}/audio`, {
      method: 'POST',
      body: JSON.stringify({
        encoding: 'pcm-s16le',
        sampleRate: 16_000,
        channels: 1,
        data: bytesToBase64(float32ToPcm16(pending.samples))
      })
    }).then(() => {
      pendingAudio.acknowledge(pending.count);
    });
    flushWork = work;
    try {
      await work;
    } finally {
      if (flushWork === work) {
        flushWork = undefined;
      }
    }
  }
}

async function reportCaptureError(error: Error): Promise<void> {
  const current = await getCaptureState();
  await saveCaptureState({
    ...current,
    active: Boolean(sessionId),
    sessionId,
    error: error.message
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('VOIVOX Chrome capture failed.');
}

async function localRequest(path: string, options: RequestInit): Promise<Response> {
  if (!bridge) {
    throw new Error('VOIVOX Chrome bridge is not paired.');
  }
  const response = await fetch(`${bridge.baseUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({} as { error?: string }));
    throw new Error(error.error ?? '桌面 VOIVOX 拒绝了这段标签页声音。');
  }
  return response;
}
