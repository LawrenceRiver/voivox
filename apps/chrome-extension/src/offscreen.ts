import { StreamingDownsampler } from './audio-codec.js';
import { AsrWorkerClient, AsrWorkerOperationError } from './asr-worker-client.js';
import {
  normalizeCaptureState,
  type BridgeConfig,
  type CaptureState
} from './bridge.js';
import type { BrowserTranscriberState } from './browser-transcriber.js';
import { CapturedAudio } from './captured-audio.js';
import type { TranscriptionMode } from './local-transcription.js';
import { syncBrowserTranscriptToDesktop } from './transcript-sync.js';

type ActiveRoute = 'browser-local';
const ASR_WORKER_IDLE_MS = 2 * 60 * 1_000;

let audioContext: AudioContext | undefined;
let audioStream: MediaStream | undefined;
let workletNode: AudioWorkletNode | undefined;
let silentGain: GainNode | undefined;
let sessionId: string | undefined;
let tabTitle: string | undefined;
let route: ActiveRoute | undefined;
let mode: TranscriptionMode = 'quality';
let bridge: BridgeConfig | undefined;
let transcriptionWork: Promise<void> | undefined;
let workerStateQueue: Promise<void> = Promise.resolve();
let operationTail: Promise<void> = Promise.resolve();
let asrClient: AsrWorkerClient | undefined;
let asrIdleTimer: ReturnType<typeof setTimeout> | undefined;
let captureLimitReached = false;
let captureGeneration = 0;
let downsampler = new StreamingDownsampler();
const capturedBrowserAudio = new CapturedAudio({ maximumSeconds: 10 * 60, sampleRate: 16_000 });

async function getCaptureState(): Promise<CaptureState> {
  const state = await chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'capture-state:get'
  });
  return normalizeCaptureState(state);
}

async function saveCaptureState(state: CaptureState): Promise<void> {
  await chrome.runtime.sendMessage({
    state,
    target: 'service-worker',
    type: 'capture-state:save'
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') {
    return;
  }

  if (message.type === 'audio:start') {
    void serializeCaptureOperation(() => startCapture(message)).then(sendResponse).catch((error: unknown) => {
      sendResponse({ error: asError(error).message });
    });
    return true;
  }

  if (message.type === 'audio:stop') {
    void serializeCaptureOperation(() => stopCaptureFromMessage()).then(sendResponse).catch((error: unknown) => {
      sendResponse({ error: asError(error).message });
    });
    return true;
  }

  if (message.type === 'audio:retry') {
    void serializeCaptureOperation(() => retryBrowserTranscription()).then((state) => sendResponse({ state })).catch((error: unknown) => {
      sendResponse({ error: asError(error).message });
    });
    return true;
  }

  if (message.type === 'audio:cancel') {
    void serializeCaptureOperation(() => cancelBrowserTranscription()).then((state) => sendResponse({ state })).catch((error: unknown) => {
      sendResponse({ error: asError(error).message });
    });
    return true;
  }
});

async function stopCaptureFromMessage(): Promise<{ state: CaptureState }> {
  return { state: await stopCapture() };
}

async function startCapture(message: {
  bridge?: BridgeConfig;
  mode: TranscriptionMode;
  route: unknown;
  streamId: string;
  tabTitle: string;
}): Promise<{ sessionId: string }> {
  if (message.route !== 'browser-local') {
    throw new Error('Chrome 标签页只能在浏览器本地转写。');
  }
  if (transcriptionWork) {
    throw new Error('请等待当前本地转写完成。');
  }
  await releaseAudioGraph();
  resetCaptureBuffers();
  sessionId = undefined;
  route = message.route;
  mode = message.mode;
  bridge = message.bridge;
  tabTitle = message.tabTitle;
  captureLimitReached = false;
  const generation = ++captureGeneration;

  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: message.streamId
        }
      } as MediaTrackConstraints
    });
    for (const track of audioStream.getTracks()) {
      track.addEventListener('ended', () => {
        void serializeCaptureOperation(async () => {
          if (generation !== captureGeneration) {
            return getCaptureState();
          }
          return stopCapture();
        }).catch((error: unknown) => enqueueCaptureError(asError(error)));
      }, { once: true });
    }

    sessionId = `browser_${crypto.randomUUID()}`;

    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
    const source = audioContext.createMediaStreamSource(audioStream);
    workletNode = new AudioWorkletNode(audioContext, 'voivox-capture');
    workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      queueAudio(event.data, audioContext?.sampleRate ?? 48_000, generation);
    };
    source.connect(workletNode);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    workletNode.connect(silentGain);
    silentGain.connect(audioContext.destination);
    await audioContext.resume();
    const started: CaptureState = {
      active: true,
      mode,
      phase: 'capturing',
      route: 'browser-local',
      sessionId,
      tabTitle: message.tabTitle
    };
    await saveCaptureState(started);
    return { sessionId };
  } catch (error) {
    await releaseAudioGraph().catch(() => undefined);
    resetCaptureBuffers();
    sessionId = undefined;
    route = undefined;
    bridge = undefined;
    throw error;
  }
}

async function stopCapture(): Promise<CaptureState> {
  const currentRoute = route;
  const currentSessionId = sessionId;
  const currentTabTitle = tabTitle;
  captureGeneration += 1;
  await releaseAudioGraph();

  if (!currentRoute || !currentSessionId) {
    const current = await getCaptureState();
    if (!current.active) {
      return current;
    }
    const recovered: CaptureState = {
      active: false,
      mode: current.mode,
      phase: 'idle'
    };
    await saveCaptureState(recovered);
    return recovered;
  }

  const baseState: CaptureState = {
    active: false,
    mode,
    phase: 'transcribing',
    route: 'browser-local',
    sessionId: currentSessionId,
    tabTitle: currentTabTitle
  };
  if (capturedBrowserAudio.isSilent()) {
    const silentState: CaptureState = {
      ...baseState,
      canRetry: false,
      error: '没有检测到可转写的标签页声音。请确认视频正在播放。',
      phase: 'error'
    };
    await saveCaptureState(silentState);
    resetCaptureBuffers();
    sessionId = undefined;
    route = undefined;
    bridge = undefined;
    return silentState;
  }

  await saveCaptureState(baseState);
  transcriptionWork = runBrowserTranscription().finally(() => {
    transcriptionWork = undefined;
  });
  return baseState;
}

async function retryBrowserTranscription(): Promise<CaptureState> {
  const current = await getCaptureState();
  if (transcriptionWork) {
    return current;
  }
  if (current.route !== 'browser-local' || !current.canRetry) {
    throw new Error('没有保留可重试的浏览器本地音频。');
  }
  const retrying: CaptureState = {
    ...current,
    canRetry: false,
    error: undefined,
    errorCode: undefined,
    phase: 'transcribing'
  };
  await saveCaptureState(retrying);
  transcriptionWork = runBrowserTranscription().finally(() => {
    transcriptionWork = undefined;
  });
  return retrying;
}

async function cancelBrowserTranscription(): Promise<CaptureState> {
  const work = transcriptionWork;
  if (!work) {
    return getCaptureState();
  }
  asrClient?.cancel();
  await work;
  return getCaptureState();
}

async function runBrowserTranscription(): Promise<void> {
  const client = getAsrClient();
  try {
    const durationSeconds = capturedBrowserAudio.durationSeconds;
    const text = await client.transcribe(capturedBrowserAudio.snapshot(), mode);
    if (!text.trim()) {
      throw new Error('本地模型没有识别出文字。你可以保留音频后重试。');
    }
    await workerStateQueue;
    const current = await getCaptureState();
    const completed: CaptureState = {
      ...current,
      active: false,
      canRetry: false,
      error: undefined,
      errorCode: undefined,
      mode,
      phase: 'complete',
      route: 'browser-local',
      transcript: text
    };
    const syncInput = {
      bridge,
      durationSeconds,
      tabTitle: tabTitle ?? '当前 Chrome 标签页',
      transcript: text
    };
    await saveCaptureState(completed);
    capturedBrowserAudio.clear();
    void syncBrowserTranscriptToDesktop(syncInput);
  } catch (error) {
    await workerStateQueue;
    const current = await getCaptureState();
    const errorCode = error instanceof AsrWorkerOperationError
      ? error.code === 'cancelled'
        ? 'transcription-cancelled'
        : 'transcription-timeout'
      : undefined;
    await saveCaptureState({
      ...current,
      active: false,
      canRetry: true,
      error: errorCode ? undefined : asError(error).message,
      errorCode,
      mode,
      phase: 'error',
      route: 'browser-local'
    });
  } finally {
    scheduleAsrClientDisposal();
  }
}

function getAsrClient(): AsrWorkerClient {
  cancelAsrClientDisposal();
  if (!asrClient) {
    const worker = new Worker(chrome.runtime.getURL('asr-worker.js'), { type: 'module' });
    let client: AsrWorkerClient;
    client = new AsrWorkerClient(
      worker,
      (state) => {
        if (asrClient !== client) {
          return;
        }
        const update = workerStateQueue.then(() => publishWorkerState(state));
        workerStateQueue = update.catch(() => undefined);
      },
      () => {
        if (asrClient !== client) {
          return;
        }
        cancelAsrClientDisposal();
        asrClient = undefined;
      }
    );
    asrClient = client;
  }
  return asrClient;
}

function scheduleAsrClientDisposal(): void {
  cancelAsrClientDisposal();
  const idleClient = asrClient;
  if (!idleClient) {
    return;
  }
  asrIdleTimer = setTimeout(() => {
    asrIdleTimer = undefined;
    if (asrClient !== idleClient) {
      return;
    }
    asrClient = undefined;
    void idleClient.dispose().catch(() => undefined);
  }, ASR_WORKER_IDLE_MS);
}

function cancelAsrClientDisposal(): void {
  if (asrIdleTimer) {
    clearTimeout(asrIdleTimer);
    asrIdleTimer = undefined;
  }
}

async function publishWorkerState(workerState: BrowserTranscriberState): Promise<void> {
  if (workerState.phase === 'idle' || workerState.phase === 'complete' || workerState.phase === 'error') {
    return;
  }
  const current = await getCaptureState();
  if (current.route !== 'browser-local') {
    return;
  }
  await saveCaptureState({
    ...current,
    active: false,
    mode: workerState.mode,
    phase: workerState.phase,
    progress: workerState.phase === 'downloading' ? workerState.progress : undefined
  });
}

async function releaseAudioGraph(): Promise<void> {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
  }
  workletNode = undefined;
  silentGain?.disconnect();
  silentGain = undefined;
  audioStream?.getTracks().forEach((track) => track.stop());
  audioStream = undefined;
  await audioContext?.close();
  audioContext = undefined;
}

function queueAudio(samples: Float32Array, sourceRate: number, generation: number): void {
  if (generation !== captureGeneration) {
    return;
  }
  const resampled = downsampler.resample(samples, sourceRate);
  if (route !== 'browser-local') {
    return;
  }
  const accepted = capturedBrowserAudio.append(resampled);
  if (!accepted && !captureLimitReached) {
    captureLimitReached = true;
    void serializeCaptureOperation(() => stopCapture())
      .catch((error: unknown) => enqueueCaptureError(asError(error)));
  }
}

async function reportCaptureError(error: Error): Promise<void> {
  const current = await getCaptureState();
  await saveCaptureState({
    ...current,
    error: error.message,
    phase: 'error'
  });
}

function enqueueCaptureError(error: Error, expectedGeneration?: number): void {
  void serializeCaptureOperation(async () => {
    if (expectedGeneration !== undefined && expectedGeneration !== captureGeneration) {
      return;
    }
    await reportCaptureError(error);
  }).catch(() => undefined);
}

function resetCaptureBuffers(): void {
  capturedBrowserAudio.clear();
  downsampler.reset();
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('VOIVOX 标签页收录失败。');
}

function serializeCaptureOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(() => undefined, () => undefined);
  return result;
}
