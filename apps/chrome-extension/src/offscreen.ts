import { StreamingDownsampler } from './audio-codec.js';
import {
  DesktopAudioRelay,
  DesktopAudioRelayError,
  type DesktopTranscriptSnapshot
} from './desktop-audio-relay.js';
import {
  normalizeCaptureState,
  type BridgeConfig,
  type CaptureState
} from './bridge.js';
import type { TranscriptionMode } from './local-transcription.js';

let audioContext: AudioContext | undefined;
let audioStream: MediaStream | undefined;
let workletNode: AudioWorkletNode | undefined;
let silentGain: GainNode | undefined;
let relay: DesktopAudioRelay | undefined;
let sessionId: string | undefined;
let tabTitle: string | undefined;
let tabUrl: string | undefined;
let tunnelSessionId: string | undefined;
let mode: TranscriptionMode = 'quality';
let captureGeneration = 0;
let operationTail: Promise<void> = Promise.resolve();
let stateUpdateTail: Promise<void> = Promise.resolve();
let transcriptionWork: Promise<void> | undefined;
let downsampler = new StreamingDownsampler();

async function getCaptureState(): Promise<CaptureState> {
  return normalizeCaptureState(await chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'capture-state:get'
  }));
}

async function saveCaptureState(state: CaptureState): Promise<void> {
  await chrome.runtime.sendMessage({
    state,
    target: 'service-worker',
    type: 'capture-state:save'
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  const operation: (() => Promise<unknown>) | undefined = message.type === 'audio:start'
    ? () => startCapture(message)
    : message.type === 'audio:stop'
      ? async () => ({ state: await stopCapture() })
      : message.type === 'audio:cancel'
        ? async () => ({ state: await cancelCapture() })
        : message.type === 'audio:retry'
          ? async () => {
              throw new Error('Voice VAC cannot retry audio that was not retained by Chrome.');
            }
          : undefined;
  if (!operation) return;

  void serializeCaptureOperation(operation)
    .then(sendResponse)
    .catch((error: unknown) => {
      const failure = error instanceof DesktopAudioRelayError ? error : undefined;
      sendResponse({
        error: asError(error).message,
        ...(failure ? { errorCode: failure.code, retryable: failure.retryable } : {})
      });
    });
  return true;
});

async function startCapture(message: {
  bridge?: BridgeConfig;
  mode: TranscriptionMode;
  route: unknown;
  streamId: string;
  tabTitle: string;
  tabUrl?: string;
  tunnelSessionId?: string;
}): Promise<{ sessionId: string }> {
  if (message.route !== 'desktop-local' || !message.bridge) {
    throw new Error('Voice VAC requires the authenticated local App relay.');
  }
  if (!message.tabUrl || !message.tunnelSessionId) {
    throw new DesktopAudioRelayError('TAB_NOT_ARMED');
  }
  if (relay || transcriptionWork) throw new DesktopAudioRelayError('STREAM_ENDED');

  await releaseAudioGraph();
  downsampler.reset();
  mode = message.mode;
  tabTitle = message.tabTitle;
  tabUrl = message.tabUrl;
  tunnelSessionId = message.tunnelSessionId;
  const generation = ++captureGeneration;

  let activeRelay: DesktopAudioRelay | undefined;
  try {
    // Consume Chrome's short-lived stream id immediately. No microphone,
    // device enumeration, or system-output source enters this graph.
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: message.streamId
        }
      } as MediaTrackConstraints
    });

    const startedRelay = new DesktopAudioRelay({
      bridge: message.bridge,
      onDelta: (snapshot) => publishTranscriptSnapshot(snapshot, generation),
      onFailure: (error) => publishRelayFailure(error, generation)
    });
    activeRelay = startedRelay;
    relay = startedRelay;

    let streamEnded = false;
    for (const track of audioStream.getTracks()) {
      track.addEventListener('ended', () => {
        streamEnded = true;
        void serializeCaptureOperation(async () => {
          if (generation !== captureGeneration || relay !== startedRelay) return;
          await stopCapture();
        }).catch((error: unknown) => {
          void publishRelayFailure(toRelayError(error), generation);
        });
      }, { once: true });
    }

    sessionId = await startedRelay.start({
      mode: message.mode,
      tabTitle: message.tabTitle,
      tabUrl: message.tabUrl,
      tunnelSessionId: message.tunnelSessionId
    });
    if (streamEnded) throw new DesktopAudioRelayError('STREAM_ENDED');

    audioContext = new AudioContext();
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
    const source = audioContext.createMediaStreamSource(audioStream);
    workletNode = new AudioWorkletNode(audioContext, 'voivox-capture');
    workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      queueAudio(event.data, audioContext?.sampleRate ?? 48_000, generation, startedRelay);
    };
    source.connect(workletNode);
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    workletNode.connect(silentGain);
    silentGain.connect(audioContext.destination);
    await audioContext.resume();

    await saveCaptureState({
      active: true,
      mode,
      phase: 'capturing',
      route: 'desktop-local',
      sessionId,
      tabTitle,
      tabUrl,
      tunnelSessionId
    });
    return { sessionId };
  } catch (error) {
    const failure = normalizeStartError(error);
    await stateUpdateTail;
    await saveCaptureState({
      active: false,
      canRetry: failure.retryable,
      error: failure.message,
      errorCode: failure.code,
      mode,
      phase: 'error',
      route: 'desktop-local',
      ...(sessionId ? { sessionId } : {}),
      ...(tabTitle ? { tabTitle } : {}),
      ...(tabUrl ? { tabUrl } : {}),
      ...(tunnelSessionId ? { tunnelSessionId } : {})
    });
    await releaseAudioGraph().catch(() => undefined);
    if (sessionId && activeRelay) {
      const stopWork = activeRelay.stop().catch(() => undefined);
      await Promise.race([stopWork, delay(250)]);
    }
    activeRelay?.cancel();
    clearCapture(generation);
    throw failure;
  }
}

async function stopCapture(): Promise<CaptureState> {
  const activeRelay = relay;
  const activeSessionId = sessionId;
  const generation = captureGeneration;
  if (!activeRelay || !activeSessionId) {
    const current = await getCaptureState();
    if (!current.active) return current;
    const idle: CaptureState = { active: false, mode: current.mode, phase: 'idle' };
    await saveCaptureState(idle);
    return idle;
  }

  await releaseAudioGraph();
  await stateUpdateTail;
  const transcribing: CaptureState = {
    active: false,
    mode,
    phase: 'transcribing',
    route: 'desktop-local',
    sessionId: activeSessionId,
    tabTitle,
    tabUrl,
    tunnelSessionId
  };
  await saveCaptureState(transcribing);

  const stopResult = activeRelay.stop();
  const completion = delay(0).then(() => finishTranscription(
    activeRelay,
    stopResult,
    transcribing,
    generation
  ));
  const tracked = completion.finally(() => {
    if (transcriptionWork === tracked) transcriptionWork = undefined;
  });
  transcriptionWork = tracked;
  void tracked.catch(() => undefined);
  return transcribing;
}

async function finishTranscription(
  activeRelay: DesktopAudioRelay,
  stopResult: Promise<DesktopTranscriptSnapshot>,
  transcribing: CaptureState,
  generation: number
): Promise<void> {
  try {
    const result = await stopResult;
    await stateUpdateTail;
    if (generation !== captureGeneration || relay !== activeRelay) return;
    await saveCaptureState({
      ...transcribing,
      active: false,
      canRetry: false,
      phase: 'complete',
      transcript: result.transcript
    });
  } catch (error) {
    const failure = toRelayError(error);
    await stateUpdateTail;
    if (generation !== captureGeneration || relay !== activeRelay) return;
    await saveCaptureState({
      ...transcribing,
      active: false,
      canRetry: failure.retryable,
      error: failure.message,
      errorCode: failure.code,
      phase: 'error'
    });
  } finally {
    clearCapture(generation);
  }
}

async function cancelCapture(): Promise<CaptureState> {
  const activeRelay = relay;
  const generation = captureGeneration;
  activeRelay?.cancel();
  await releaseAudioGraph();
  await transcriptionWork?.catch(() => undefined);
  const current = await getCaptureState();
  const cancelled: CaptureState = {
    ...current,
    active: false,
    canRetry: false,
    error: 'The transcription was cancelled.',
    errorCode: 'TRANSCRIPTION_CANCELLED',
    phase: 'error',
    route: 'desktop-local'
  };
  await saveCaptureState(cancelled);
  clearCapture(generation);
  return cancelled;
}

function queueAudio(
  samples: Float32Array,
  sourceRate: number,
  generation: number,
  activeRelay: DesktopAudioRelay
): void {
  if (generation !== captureGeneration || relay !== activeRelay) return;
  try {
    activeRelay.append(downsampler.resample(samples, sourceRate));
  } catch (error) {
    const failure = toRelayError(error);
    void publishRelayFailure(failure, generation);
    void serializeCaptureOperation(async () => {
      if (generation === captureGeneration && relay === activeRelay) await stopCapture();
    }).catch(() => undefined);
  }
}

function publishTranscriptSnapshot(
  snapshot: DesktopTranscriptSnapshot,
  generation: number
): Promise<void> {
  return enqueueStateUpdate(async () => {
    if (generation !== captureGeneration) return;
    const current = await getCaptureState();
    if (current.route !== 'desktop-local' || current.sessionId !== snapshot.sessionId) return;
    await saveCaptureState({
      ...current,
      transcript: snapshot.transcript
    });
  });
}

function publishRelayFailure(
  error: DesktopAudioRelayError,
  generation: number
): Promise<void> {
  return enqueueStateUpdate(async () => {
    if (generation !== captureGeneration) return;
    const current = await getCaptureState();
    await saveCaptureState({
      ...current,
      active: false,
      canRetry: error.retryable,
      error: error.message,
      errorCode: error.code,
      phase: 'error',
      route: 'desktop-local'
    });
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

function clearCapture(generation: number): void {
  if (generation !== captureGeneration) return;
  captureGeneration += 1;
  relay = undefined;
  sessionId = undefined;
  tabTitle = undefined;
  tabUrl = undefined;
  tunnelSessionId = undefined;
  downsampler.reset();
}

function normalizeStartError(error: unknown): DesktopAudioRelayError {
  if (error instanceof DesktopAudioRelayError) return error;
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return new DesktopAudioRelayError('CAPTURE_DENIED');
  }
  return new DesktopAudioRelayError('STREAM_ID_EXPIRED', undefined, undefined, { cause: error });
}

function toRelayError(error: unknown): DesktopAudioRelayError {
  return error instanceof DesktopAudioRelayError
    ? error
    : new DesktopAudioRelayError('ASR_INFERENCE_FAILED', undefined, undefined, { cause: error });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Voice VAC could not relay this tab audio.');
}

function serializeCaptureOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(() => undefined, () => undefined);
  return result;
}

function enqueueStateUpdate(operation: () => Promise<void>): Promise<void> {
  const result = stateUpdateTail.then(operation, operation);
  stateUpdateTail = result.catch(() => undefined);
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
