import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaptureState } from '../src/bridge.js';
import type {
  DesktopAudioRelayError,
  DesktopTranscriptSnapshot
} from '../src/desktop-audio-relay.js';

const relayMock = vi.hoisted(() => ({
  instances: [] as FakeRelay[],
  startError: undefined as Error | undefined,
  stopError: undefined as Error | undefined,
  stopResult: {
    revision: 2,
    segments: [{ startMs: 0, endMs: 1_000, text: '本地 Qwen 转录' }],
    sessionId: 'session_1',
    status: 'complete',
    transcript: '本地 Qwen 转录'
  } satisfies DesktopTranscriptSnapshot
}));

type FakeRelay = {
  append: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  emitFailure: (error: DesktopAudioRelayError) => Promise<void>;
  emitSnapshot: (snapshot: DesktopTranscriptSnapshot) => Promise<void>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

vi.mock('../src/desktop-audio-relay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/desktop-audio-relay.js')>();
  return {
    ...actual,
    DesktopAudioRelay: class {
      readonly append = vi.fn();
      readonly cancel = vi.fn();
      readonly start = vi.fn(async () => {
        if (relayMock.startError) throw relayMock.startError;
        return 'session_1';
      });
      readonly stop = vi.fn(async () => {
        if (relayMock.stopError) throw relayMock.stopError;
        return relayMock.stopResult;
      });
      private readonly onDelta?: (snapshot: DesktopTranscriptSnapshot) => void | Promise<void>;
      private readonly onFailure?: (error: DesktopAudioRelayError) => void | Promise<void>;

      constructor(options: {
        onDelta?: (snapshot: DesktopTranscriptSnapshot) => void | Promise<void>;
        onFailure?: (error: DesktopAudioRelayError) => void | Promise<void>;
      }) {
        this.onDelta = options.onDelta;
        this.onFailure = options.onFailure;
        relayMock.instances.push(this);
      }

      async emitFailure(error: DesktopAudioRelayError): Promise<void> {
        await this.onFailure?.(error);
      }

      async emitSnapshot(snapshot: DesktopTranscriptSnapshot): Promise<void> {
        await this.onDelta?.(snapshot);
      }
    }
  };
});

type OffscreenResponse = {
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  sessionId?: string;
  state?: CaptureState;
};

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: OffscreenResponse) => void
) => boolean | undefined;

describe('offscreen desktop PCM relay', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    relayMock.instances.length = 0;
    relayMock.startError = undefined;
    relayMock.stopError = undefined;
  });

  it('acquires only the authorized tab source and keeps the captured tab silent at zero gain', async () => {
    const harness = await createHarness();

    await harness.dispatch(startMessage());

    expect(harness.getUserMedia).toHaveBeenCalledWith({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: 'stream-id'
        }
      }
    });
    expect(harness.lastGain?.gain.value).toBe(0);
    expect(harness.workerConstructed).toBe(false);
  });

  it('starts the desktop capture with the armed tunnel and canonical page URL', async () => {
    const harness = await createHarness();

    const result = await harness.dispatch(startMessage());

    expect(result.sessionId).toBe('session_1');
    expect(relayMock.instances[0]?.start).toHaveBeenCalledWith({
      mode: 'quality',
      tabTitle: 'Target video',
      tabUrl: 'https://example.test/watch',
      tunnelSessionId: 'tunnel-1'
    });
    expect(harness.savedState).toMatchObject({
      active: true,
      phase: 'capturing',
      route: 'desktop-local',
      sessionId: 'session_1',
      tunnelSessionId: 'tunnel-1'
    });
  });

  it('relays downsampled worklet audio without constructing a browser ASR Worker', async () => {
    const harness = await createHarness({ sampleRate: 48_000 });
    await harness.dispatch(startMessage());

    harness.emitAudio(new Float32Array(480).fill(0.25));

    const appended = relayMock.instances[0]?.append.mock.calls[0]?.[0] as Float32Array;
    expect(appended).toBeInstanceOf(Float32Array);
    expect(appended).toHaveLength(160);
    expect(harness.workerConstructed).toBe(false);
  });

  it('drains the relay on stop and publishes the complete desktop transcript', async () => {
    const harness = await createHarness();
    await harness.dispatch(startMessage());
    harness.emitAudio(new Float32Array(200).fill(0.1));

    const stopped = await harness.dispatch({ target: 'offscreen', type: 'audio:stop' });

    expect(relayMock.instances[0]?.stop).toHaveBeenCalledOnce();
    expect(stopped.state).toMatchObject({
      active: false,
      phase: 'transcribing',
      route: 'desktop-local'
    });
    await harness.waitForState((state) => state.phase === 'complete');
    expect(harness.savedState).toMatchObject({
      active: false,
      phase: 'complete',
      route: 'desktop-local',
      transcript: '本地 Qwen 转录'
    });
    expect(harness.hasActiveAudioHandler()).toBe(false);
  });

  it('automatically drains when the captured tab track ends', async () => {
    const harness = await createHarness();
    await harness.dispatch(startMessage());

    harness.track.dispatchEvent(new Event('ended'));

    await harness.waitForState((state) => state.phase === 'complete');
    expect(relayMock.instances[0]?.stop).toHaveBeenCalledOnce();
  });

  it('maps an exact stable desktop failure into CaptureState', async () => {
    const { DesktopAudioRelayError } = await import('../src/desktop-audio-relay.js');
    const harness = await createHarness();
    await harness.dispatch(startMessage());
    relayMock.stopError = new DesktopAudioRelayError(
      'ASR_MODEL_MISSING',
      'The local Qwen3-ASR model is not installed.',
      false
    );

    const stopped = await harness.dispatch({ target: 'offscreen', type: 'audio:stop' });

    expect(stopped.state).toMatchObject({
      active: false,
      phase: 'transcribing',
      route: 'desktop-local'
    });
    await harness.waitForState((state) => state.phase === 'error');
    expect(harness.savedState).toMatchObject({
      active: false,
      canRetry: false,
      errorCode: 'ASR_MODEL_MISSING',
      phase: 'error',
      route: 'desktop-local'
    });
  });

  it('publishes an exact stable start failure before releasing the captured tab', async () => {
    const { DesktopAudioRelayError } = await import('../src/desktop-audio-relay.js');
    relayMock.startError = new DesktopAudioRelayError(
      'ASR_MODEL_MISSING',
      'The local Qwen3-ASR model is not installed.',
      false
    );
    const harness = await createHarness();

    const response = await harness.dispatch(startMessage());

    expect(response).toMatchObject({
      error: 'The local Qwen3-ASR model is not installed.',
      errorCode: 'ASR_MODEL_MISSING',
      retryable: false
    });
    expect(harness.savedState).toMatchObject({
      active: false,
      errorCode: 'ASR_MODEL_MISSING',
      phase: 'error',
      route: 'desktop-local'
    });
  });

  it('rejects every route except authenticated desktop-local before capture', async () => {
    const harness = await createHarness();
    const response = await harness.dispatch({ ...startMessage(), route: 'browser-local' });

    expect(response).toEqual({ error: 'Voice VAC requires the authenticated local App relay.' });
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(relayMock.instances).toHaveLength(0);
  });
});

function startMessage(): Record<string, unknown> {
  return {
    bridge: { baseUrl: 'http://127.0.0.1:43817', token: 'restricted-token' },
    mode: 'quality',
    route: 'desktop-local',
    streamId: 'stream-id',
    tabTitle: 'Target video',
    tabUrl: 'https://example.test/watch',
    target: 'offscreen',
    tunnelSessionId: 'tunnel-1',
    type: 'audio:start'
  };
}

async function createHarness(options: { sampleRate?: number } = {}): Promise<{
  dispatch: (message: unknown) => Promise<OffscreenResponse>;
  emitAudio: (audio: Float32Array) => void;
  getUserMedia: ReturnType<typeof vi.fn>;
  hasActiveAudioHandler: () => boolean;
  lastGain?: GainNode;
  readonly savedState: CaptureState;
  track: FakeTrack;
  waitForState: (predicate: (state: CaptureState) => boolean) => Promise<void>;
  workerConstructed: boolean;
}> {
  let listener: RuntimeListener | undefined;
  let state: CaptureState = { active: false, mode: 'quality', phase: 'armed' };
  let activeNode: FakeAudioWorkletNode | undefined;
  let lastContext: FakeAudioContext | undefined;
  let workerConstructed = false;
  const track = new FakeTrack();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));

  class TestAudioWorkletNode extends FakeAudioWorkletNode {
    constructor() {
      super();
      activeNode = this;
    }
  }
  class TestAudioContext extends FakeAudioContext {
    constructor() {
      super(options.sampleRate ?? 16_000);
      lastContext = this;
    }
  }

  vi.stubGlobal('Worker', class {
    constructor() {
      workerConstructed = true;
    }
  });
  vi.stubGlobal('AudioWorkletNode', TestAudioWorkletNode);
  vi.stubGlobal('AudioContext', TestAudioContext);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => `chrome-extension://voice-vac/${path}`,
      onMessage: {
        addListener: vi.fn((registered: RuntimeListener) => {
          listener = registered;
        })
      },
      sendMessage: vi.fn(async (message: Record<string, unknown>) => {
        if (message.type === 'capture-state:get') return state;
        if (message.type === 'capture-state:save') {
          state = message.state as CaptureState;
          return state;
        }
        throw new Error(`Unexpected message ${String(message.type)}`);
      })
    }
  });

  await import('../src/offscreen.js');
  if (!listener) throw new Error('Offscreen listener was not registered.');

  return {
    dispatch: (message) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Offscreen response timed out.')), 1_000);
      const kept = listener?.(message, {} as chrome.runtime.MessageSender, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      if (!kept) {
        clearTimeout(timeout);
        reject(new Error('Offscreen channel was not kept alive.'));
      }
    }),
    emitAudio: (audio) => {
      if (!activeNode?.port.onmessage) throw new Error('Audio handler is not active.');
      activeNode.port.onmessage({ data: audio } as MessageEvent<Float32Array>);
    },
    getUserMedia,
    hasActiveAudioHandler: () => Boolean(activeNode?.port.onmessage),
    get lastGain() {
      return lastContext?.gain;
    },
    get savedState() {
      return state;
    },
    track,
    waitForState: async (predicate) => {
      await vi.waitFor(() => expect(predicate(state)).toBe(true), { interval: 5, timeout: 500 });
    },
    get workerConstructed() {
      return workerConstructed;
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
  readonly close = vi.fn(async () => undefined);
  readonly gain = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1 }
  } as unknown as GainNode;
  readonly resume = vi.fn(async () => undefined);

  constructor(readonly sampleRate: number) {}

  createGain(): GainNode {
    return this.gain;
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return { connect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
  }

}
