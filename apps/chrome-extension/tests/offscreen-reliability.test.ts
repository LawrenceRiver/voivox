import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaptureState } from '../src/bridge.js';

const asrMock = vi.hoisted(() => {
  class OperationError extends Error {
    constructor(readonly code: 'cancelled' | 'timeout') {
      super(code === 'cancelled' ? 'Browser-local transcription was cancelled.' : 'Browser-local transcription timed out.');
      this.name = 'AsrWorkerOperationError';
    }
  }

  return {
    OperationError,
    instances: [] as Array<{
      audios: Float32Array[];
      cancel: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      triggerFatal: () => void;
    }>,
    results: [] as Array<string | Error | { pending: true }>
  };
});

vi.mock('../src/asr-worker-client.js', () => ({
  AsrWorkerOperationError: asrMock.OperationError,
  AsrWorkerClient: class {
    readonly audios: Float32Array[] = [];
    readonly cancel = vi.fn(() => {
      const error = new asrMock.OperationError('cancelled');
      this.pendingReject?.(error);
      this.pendingReject = undefined;
      this.onFatalError?.(error);
    });
    readonly dispose = vi.fn(async () => undefined);
    private readonly onFatalError?: (error: Error) => void;
    private pendingReject?: (error: Error) => void;

    constructor(
      _worker: unknown,
      _onStateChange: unknown,
      onFatalError?: (error: Error) => void
    ) {
      this.onFatalError = onFatalError;
      asrMock.instances.push(this);
    }

    async transcribe(audio: Float32Array): Promise<string> {
      this.audios.push(audio.slice());
      const result = asrMock.results.shift() ?? 'browser transcript';
      if (result instanceof Error) {
        throw result;
      }
      if (typeof result !== 'string') {
        return new Promise<string>((_resolve, reject) => {
          this.pendingReject = reject;
        });
      }
      return result;
    }

    triggerFatal(): void {
      this.onFatalError?.(new Error('old worker crashed late'));
    }
  }
}));

type OffscreenResponse = {
  error?: string;
  lostDesktopSessionId?: string;
  sessionId?: string;
  state?: CaptureState;
};

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: OffscreenResponse) => void
) => boolean | undefined;

describe('offscreen capture reliability', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
    asrMock.instances.length = 0;
    asrMock.results.length = 0;
  });

  it('clears stale active storage when asked to stop without a live capture', async () => {
    const harness = await createHarness();

    const stopped = await harness.dispatch({ target: 'offscreen', type: 'audio:stop' });

    expect(stopped.state).toEqual({ active: false, mode: 'quality', phase: 'idle' });
    expect(harness.savedState).toEqual(stopped.state);
  });

  it('keeps the ASR worker unloaded while it is only capturing audio', async () => {
    const harness = await createHarness();

    await harness.dispatch(startMessage('browser-local'));

    expect(asrMock.instances).toHaveLength(0);
  });

  it('publishes the capturing state before acknowledging startup', async () => {
    const harness = await createHarness({
      initialState: { active: false, mode: 'quality', phase: 'idle' }
    });

    const started = await harness.dispatch(startMessage('browser-local'));

    expect(harness.savedState).toMatchObject({
      active: true,
      mode: 'quality',
      phase: 'capturing',
      route: 'browser-local',
      sessionId: started.sessionId,
      tabTitle: 'Test tab'
    });
  });

  it('persists state through runtime messaging when offscreen storage APIs are unavailable', async () => {
    const harness = await createHarness({
      initialState: { active: false, mode: 'quality', phase: 'idle' },
      offscreenStorageAvailable: false
    });

    const started = await harness.dispatch(startMessage('browser-local'));

    expect(started.sessionId).toMatch(/^browser_/u);
    expect(harness.savedState).toMatchObject({
      active: true,
      phase: 'capturing',
      route: 'browser-local',
      sessionId: started.sessionId
    });
    expect(harness.stateMessages.map((message) => message.type)).toContain('capture-state:save');
  });

  it('serializes start and stop operations', async () => {
    const harness = await createHarness({ deferMedia: true });
    asrMock.results.push('serialized transcript');
    const starting = harness.dispatch(startMessage('browser-local'));
    const stopping = harness.dispatch({ target: 'offscreen', type: 'audio:stop' });

    harness.releaseMedia();
    const started = await starting;
    const stopped = await stopping;

    expect(started.sessionId).toMatch(/^browser_/u);
    expect(stopped.state).toMatchObject({ active: false, phase: 'error', route: 'browser-local' });
  });

  it('automatically stops and transcribes when the captured tab track ends', async () => {
    const harness = await createHarness();
    asrMock.results.push('automatic transcript');
    await harness.dispatch(startMessage('browser-local'));
    harness.emitAudio(new Float32Array(2_000).fill(0.02));

    harness.track.dispatchEvent(new Event('ended'));

    await harness.waitForState((state) => state.transcript === 'automatic transcript');
    expect(harness.savedState).toMatchObject({ active: false, phase: 'complete' });
  });

  it('ignores an already queued audio message from a released capture generation', async () => {
    const harness = await createHarness();
    asrMock.results.push('first transcript', 'second transcript');
    await harness.dispatch(startMessage('browser-local'));
    const dispatchReleasedAudio = harness.captureAudioDispatcher();
    harness.emitAudio(new Float32Array(2_000).fill(0.02));
    await harness.dispatch({ target: 'offscreen', type: 'audio:stop' });
    await harness.waitForState((state) => state.transcript === 'first transcript');

    await harness.dispatch(startMessage('browser-local'));
    dispatchReleasedAudio(new Float32Array(1_000).fill(0.75));
    const currentAudio = new Float32Array(2_000).fill(0.03);
    harness.emitAudio(currentAudio);
    await harness.dispatch({ target: 'offscreen', type: 'audio:stop' });
    await harness.waitForState((state) => state.transcript === 'second transcript');

    expect(asrMock.instances[0]?.audios[1]).toEqual(currentAudio);
  });

  it('detaches the audio message handler when the capture graph is released', async () => {
    const harness = await createHarness();
    await harness.dispatch(startMessage('browser-local'));

    expect(harness.hasActiveAudioHandler()).toBe(true);
    await harness.dispatch({ target: 'offscreen', type: 'audio:stop' });

    expect(harness.hasActiveAudioHandler()).toBe(false);
  });

  it('rejects the obsolete desktop audio route before opening an App session', async () => {
    const harness = await createHarness();

    const started = await harness.dispatch(startMessage('desktop-local'));

    expect(started).toEqual({ error: 'Chrome 标签页只能在浏览器本地转写。' });
    expect(harness.requestedUrls).toHaveLength(0);
    expect(harness.hasActiveAudioHandler()).toBe(false);
  });

  it('disposes an idle model after two minutes and recreates it for retry without losing audio', async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    asrMock.results.push(new Error('temporary model failure'), 'retry transcript');
    await harness.dispatch(startMessage('browser-local'));
    const captured = new Float32Array(2_000).fill(0.02);
    harness.emitAudio(captured);
    await harness.dispatch({ target: 'offscreen', type: 'audio:stop' });
    await flushMicrotasks();
    expect(harness.savedState).toMatchObject({ canRetry: true, phase: 'error' });
    expect(asrMock.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(asrMock.instances[0]?.dispose).toHaveBeenCalledOnce();

    const retrying = await harness.dispatch({ target: 'offscreen', type: 'audio:retry' });
    expect(retrying.state).toMatchObject({ canRetry: false, phase: 'transcribing' });
    await flushMicrotasks();

    expect(asrMock.instances).toHaveLength(2);
    expect(asrMock.instances[1]?.audios[0]).toEqual(captured);
    expect(harness.savedState).toMatchObject({ phase: 'complete', transcript: 'retry transcript' });
  });

  it('cancels processing, keeps captured audio, and recreates the worker for retry', async () => {
    const harness = await createHarness();
    asrMock.results.push({ pending: true }, 'retry after cancellation');
    await harness.dispatch(startMessage('browser-local'));
    const captured = new Float32Array(2_000).fill(0.02);
    harness.emitAudio(captured);

    const stopped = await harness.dispatch({ target: 'offscreen', type: 'audio:stop' });
    expect(stopped.state).toMatchObject({ phase: 'transcribing', route: 'browser-local' });
    const cancelled = await harness.dispatch({ target: 'offscreen', type: 'audio:cancel' });

    expect(cancelled.state).toMatchObject({
      canRetry: true,
      errorCode: 'TRANSCRIPTION_CANCELLED',
      phase: 'error',
      route: 'browser-local'
    });
    expect(asrMock.instances[0]?.cancel).toHaveBeenCalledOnce();

    const retrying = await harness.dispatch({ target: 'offscreen', type: 'audio:retry' });
    expect(retrying.state).toMatchObject({ canRetry: false, phase: 'transcribing' });
    await harness.waitForState((state) => state.transcript === 'retry after cancellation');

    expect(asrMock.instances).toHaveLength(2);
    expect(asrMock.instances[1]?.audios[0]).toEqual(captured);
  });

  it('ignores a late fatal event from a worker that was already replaced', async () => {
    vi.useFakeTimers();
    const harness = await createHarness();
    asrMock.results.push(new Error('first worker failed'), 'replacement transcript');
    await harness.dispatch(startMessage('browser-local'));
    harness.emitAudio(new Float32Array(2_000).fill(0.02));
    await harness.dispatch({ target: 'offscreen', type: 'audio:stop' });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(120_000);

    await harness.dispatch({ target: 'offscreen', type: 'audio:retry' });
    await flushMicrotasks();
    expect(asrMock.instances).toHaveLength(2);
    asrMock.instances[0]?.triggerFatal();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(asrMock.instances[1]?.dispose).toHaveBeenCalledOnce();
  });
});

function startMessage(route: 'browser-local' | 'desktop-local'): Record<string, unknown> {
  return {
    bridge: route === 'desktop-local'
      ? { baseUrl: 'http://127.0.0.1:43817', token: 'restricted-token' }
      : undefined,
    mode: 'quality',
    route,
    streamId: 'stream-id',
    tabTitle: 'Test tab',
    target: 'offscreen',
    type: 'audio:start'
  };
}

async function createHarness(options: {
  deferMedia?: boolean;
  initialState?: CaptureState;
  offscreenStorageAvailable?: boolean;
} = {}): Promise<{
  captureAudioDispatcher: () => (audio: Float32Array) => void;
  dispatch: (message: unknown) => Promise<OffscreenResponse>;
  emitAudio: (audio: Float32Array) => void;
  hasActiveAudioHandler: () => boolean;
  releaseMedia: () => void;
  requestedUrls: string[];
  stateMessages: Array<Record<string, unknown>>;
  readonly savedState: CaptureState;
  track: FakeTrack;
  waitForState: (predicate: (state: CaptureState) => boolean) => Promise<void>;
}> {
  vi.resetModules();
  let listener: RuntimeListener | undefined;
  let state: CaptureState = options.initialState
    ?? { active: true, mode: 'quality', phase: 'capturing' };
  const extraStorage: Record<string, unknown> = {};
  let activeNode: FakeAudioWorkletNode | undefined;
  let releaseMedia: () => void = () => undefined;
  const mediaGate = options.deferMedia
    ? new Promise<void>((resolve) => {
        releaseMedia = resolve;
      })
    : Promise.resolve();
  const track = new FakeTrack();
  const requestedUrls: string[] = [];
  const stateMessages: Array<Record<string, unknown>> = [];

  class TestAudioWorkletNode extends FakeAudioWorkletNode {
    constructor() {
      super();
      activeNode = this;
    }
  }

  vi.stubGlobal('Worker', class {});
  vi.stubGlobal('AudioWorkletNode', TestAudioWorkletNode);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        await mediaGate;
        return { getTracks: () => [track] };
      })
    }
  });
  const chromeStub: Record<string, unknown> = {
    runtime: {
      getURL: (path: string) => `chrome-extension://voivox/${path}`,
      onMessage: {
        addListener: vi.fn((registered: RuntimeListener) => {
          listener = registered;
        })
      },
      sendMessage: vi.fn(async (message: Record<string, unknown>) => {
        stateMessages.push(message);
        if (message.type === 'capture-state:get') {
          return state;
        }
        if (message.type === 'capture-state:save') {
          state = message.state as CaptureState;
          return state;
        }
        throw new Error(`Unexpected runtime message: ${String(message.type)}`);
      })
    }
  };
  if (options.offscreenStorageAvailable !== false) {
    chromeStub.storage = {
      local: {
        get: vi.fn(async (key: string) => ({
          [key]: key === 'voivoxCaptureState' ? state : extraStorage[key]
        })),
        remove: vi.fn(async (key: string) => {
          delete extraStorage[key];
        }),
        set: vi.fn(async (value: Record<string, unknown>) => {
          if (value.voivoxCaptureState) {
            state = value.voivoxCaptureState as CaptureState;
          }
          for (const [key, storedValue] of Object.entries(value)) {
            if (key !== 'voivoxCaptureState') {
              extraStorage[key] = storedValue;
            }
          }
        })
      }
    };
  }
  vi.stubGlobal('chrome', chromeStub);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    return jsonResponse({ ok: true });
  }));

  await import('../src/offscreen.js');
  if (!listener) {
    throw new Error('The offscreen document did not register a runtime listener.');
  }

  return {
    captureAudioDispatcher: () => {
      const listener = activeNode?.port.onmessage;
      if (!listener) {
        throw new Error('The audio worklet is not connected.');
      }
      return (audio) => listener({ data: audio } as MessageEvent<Float32Array>);
    },
    dispatch: (message) => new Promise<OffscreenResponse>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Offscreen response timed out.')), 60_000);
      const keepAlive = listener?.(message, {} as chrome.runtime.MessageSender, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      if (!keepAlive) {
        clearTimeout(timeout);
        reject(new Error('The offscreen message channel was not kept alive.'));
      }
    }),
    emitAudio: (audio) => {
      if (!activeNode?.port.onmessage) {
        throw new Error('The audio worklet is not connected.');
      }
      activeNode.port.onmessage({ data: audio } as MessageEvent<Float32Array>);
    },
    hasActiveAudioHandler: () => Boolean(activeNode?.port.onmessage),
    releaseMedia,
    requestedUrls,
    stateMessages,
    get savedState() {
      return state;
    },
    track,
    waitForState: async (predicate) => {
      await vi.waitFor(() => {
        expect(predicate(state)).toBe(true);
      }, { interval: 5, timeout: 500 });
    }
  };
}

class FakeTrack extends EventTarget {
  readonly stop = vi.fn();
}

class FakeAudioWorkletNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly port: { onmessage: ((event: MessageEvent<Float32Array>) => void) | null } = {
    onmessage: null
  };
}

class FakeAudioContext {
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  readonly destination = {};
  readonly sampleRate = 16_000;
  readonly close = vi.fn(async () => undefined);
  readonly resume = vi.fn(async () => undefined);

  createGain(): GainNode {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: { value: 1 }
    } as unknown as GainNode;
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return { connect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}
