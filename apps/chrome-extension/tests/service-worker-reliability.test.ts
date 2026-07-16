import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaptureState } from '../src/bridge.js';

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: CaptureState) => void
) => boolean | undefined;

describe('service worker capture reliability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('recovers a stale active state when the offscreen document was reclaimed', async () => {
    const harness = await createHarness({
      active: true,
      mode: 'quality',
      phase: 'capturing',
      route: 'browser-local',
      sessionId: 'lost-session',
      tabTitle: 'Lost tab'
    });

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

    expect(state).toEqual({ active: false, mode: 'quality', phase: 'idle' });
    expect(harness.offscreenMessages).toHaveLength(0);
    expect(harness.savedState).toEqual(state);
  });

  it('keeps Chrome tab audio browser-local when the App ASR is ready', async () => {
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'idle' },
      false,
      undefined,
      true
    );

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

    expect(harness.offscreenMessages[0]).toMatchObject({
      bridge: {
        baseUrl: 'http://127.0.0.1:43817',
        token: 'restricted-token'
      },
      route: 'browser-local',
      type: 'audio:start'
    });
    expect(state).toMatchObject({ active: true, route: 'browser-local' });
    expect(harness.requestedUrls).toHaveLength(0);
  });

  it('clears an obsolete desktop-local state without contacting the App', async () => {
    const harness = await createHarness({
      active: true,
      mode: 'quality',
      phase: 'capturing',
      route: 'desktop-local',
      sessionId: 'desktop-orphan'
    } as unknown as CaptureState, false, undefined, true);

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

    expect(harness.requestedUrls).toHaveLength(0);
    expect(state).toEqual({ active: false, mode: 'quality', phase: 'idle' });
  });

  it('does not offer a retry after the offscreen audio buffer was reclaimed', async () => {
    const harness = await createHarness({
      active: false,
      canRetry: true,
      error: 'model failed',
      mode: 'quality',
      phase: 'error',
      route: 'browser-local',
      sessionId: 'lost-buffer'
    });

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:retry' });

    expect(state).toMatchObject({ active: false, canRetry: false, phase: 'error' });
    expect(state.error).toContain('音频');
    expect(harness.offscreenMessages).toHaveLength(0);
  });

  it.each(['downloading', 'transcribing'] as const)(
    'sends cancellation to the live offscreen worker while %s',
    async (phase) => {
      const harness = await createHarness(
        {
          active: false,
          mode: 'quality',
          phase,
          route: 'browser-local',
          sessionId: 'browser-processing'
        },
        false,
        undefined,
        false,
        false,
        false,
        true
      );

      const state = await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

      expect(harness.offscreenMessages.at(-1)).toMatchObject({ type: 'audio:cancel' });
      expect(state).toMatchObject({ canRetry: true, phase: 'error', route: 'browser-local' });
    }
  );

  it('serializes rapid capture toggles and creates only one offscreen document', async () => {
    const harness = await createHarness({ active: false, mode: 'fast', phase: 'idle' }, true);

    const starting = harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });
    const stopping = harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });
    await Promise.resolve();
    harness.releaseStart();

    const [startedState, stoppedState] = await Promise.all([starting, stopping]);

    expect(startedState.active).toBe(true);
    expect(stoppedState.active).toBe(false);
    expect(harness.offscreenMessages.map((message) => message.type)).toEqual(['audio:start', 'audio:stop']);
    expect(harness.createDocumentCalls()).toBe(1);
  });

  it('does not overwrite a track-ended state published by offscreen during startup', async () => {
    const completedDuringStart: CaptureState = {
      active: false,
      mode: 'quality',
      phase: 'complete',
      route: 'browser-local',
      sessionId: 'browser-session',
      transcript: 'short tab audio'
    };
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'idle' },
      false,
      completedDuringStart
    );

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

    expect(state).toEqual(completedDuringStart);
    expect(harness.savedState).toEqual(completedDuringStart);
  });

  it('keeps failed-operation state persistence inside the serial queue', async () => {
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'idle' },
      false,
      undefined,
      false,
      true,
      true
    );

    const first = harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });
    await harness.waitForErrorWriteStarted();
    const second = harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.offscreenMessages.filter((message) => message.type === 'audio:start')).toHaveLength(1);
    harness.releaseErrorWrite();
    await Promise.all([first, second]);

    expect(harness.savedState).toMatchObject({ active: true, phase: 'capturing' });
  });
});

async function createHarness(
  initialState: CaptureState,
  delayStart = false,
  stateAfterStart?: CaptureState,
  nativeDesktopReady = false,
  failFirstStart = false,
  delayErrorWrite = false,
  initialHasOffscreenDocument = false
): Promise<{
  createDocumentCalls: () => number;
  dispatch: (message: unknown) => Promise<CaptureState>;
  offscreenMessages: Array<Record<string, unknown>>;
  requestedUrls: string[];
  releaseStart: () => void;
  releaseErrorWrite: () => void;
  waitForErrorWriteStarted: () => Promise<void>;
  readonly savedState: CaptureState;
}> {
  let listener: RuntimeListener | undefined;
  let state = initialState;
  const extraStorage: Record<string, unknown> = {};
  let hasOffscreenDocument = initialHasOffscreenDocument;
  let nativeReady = nativeDesktopReady;
  let createDocumentCalls = 0;
  let releaseStart: () => void = () => undefined;
  let releaseErrorWrite: () => void = () => undefined;
  let startAttempts = 0;
  let markErrorWriteStarted: () => void = () => undefined;
  const startGate = delayStart
    ? new Promise<void>((resolve) => {
        releaseStart = resolve;
      })
    : Promise.resolve();
  const errorWriteGate = delayErrorWrite
    ? new Promise<void>((resolve) => {
        releaseErrorWrite = resolve;
      })
    : Promise.resolve();
  const errorWriteStarted = new Promise<void>((resolve) => {
    markErrorWriteStarted = resolve;
  });
  const offscreenMessages: Array<Record<string, unknown>> = [];
  const requestedUrls: string[] = [];

  const chromeStub = {
    offscreen: {
      createDocument: vi.fn(async () => {
        createDocumentCalls += 1;
        hasOffscreenDocument = true;
      }),
      Reason: { USER_MEDIA: 'USER_MEDIA' }
    },
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getContexts: vi.fn(async () => hasOffscreenDocument ? [{}] : []),
      lastError: undefined,
      onMessage: {
        addListener: vi.fn((registered: RuntimeListener) => {
          listener = registered;
        })
      },
      sendMessage: vi.fn(async (message: Record<string, unknown>) => {
        offscreenMessages.push(message);
        if (message.type === 'audio:start') {
          startAttempts += 1;
          await startGate;
          if (failFirstStart && startAttempts === 1) {
            return { error: 'first start failed' };
          }
          state = stateAfterStart ?? {
            active: true,
            mode: message.mode === 'fast' ? 'fast' : 'quality',
            phase: 'capturing',
            route: 'browser-local',
            sessionId: 'browser-session',
            tabTitle: 'Current tab'
          };
          return { sessionId: 'browser-session' };
        }
        if (message.type === 'audio:cancel') {
          state = {
            ...state,
            active: false,
            canRetry: true,
            error: 'transcription cancelled',
            phase: 'error',
            route: 'browser-local'
          };
          return { state };
        }
        state = {
          active: false,
          mode: state.mode,
          phase: 'complete',
          route: state.route,
          sessionId: state.sessionId,
          transcript: 'done'
        };
        return { state };
      }),
      sendNativeMessage: vi.fn((_host: string, _message: unknown, callback: (value: unknown) => void) => {
        callback(nativeReady ? {
          baseUrl: 'http://127.0.0.1:43817',
          capabilities: { localAsr: 'ready' },
          protocolVersion: 1,
          service: 'voivox',
          status: 'ready',
          token: 'restricted-token'
        } : undefined);
      })
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({
          [key]: key === 'voivoxCaptureState' ? state : extraStorage[key]
        })),
        remove: vi.fn(async (key: string) => {
          delete extraStorage[key];
        }),
        set: vi.fn(async (value: Record<string, unknown>) => {
          if (value.voivoxCaptureState) {
            const nextState = value.voivoxCaptureState as CaptureState;
            if (delayErrorWrite && nextState.phase === 'error') {
              markErrorWriteStarted();
              await errorWriteGate;
            }
            state = nextState;
          }
          for (const [key, storedValue] of Object.entries(value)) {
            if (key !== 'voivoxCaptureState') {
              extraStorage[key] = storedValue;
            }
          }
        })
      }
    },
    tabCapture: {
      getMediaStreamId: vi.fn((_options: unknown, callback: (streamId: string) => void) => {
        callback('stream-id');
      })
    },
    tabs: {
      query: vi.fn(async () => [{ id: 17, title: 'Current tab' }])
    }
  };
  vi.stubGlobal('chrome', chromeStub);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    requestedUrls.push(String(input));
    return new Response('{}', { status: 200 });
  }));
  await import('../src/service-worker.js');
  if (!listener) {
    throw new Error('The service worker did not register a runtime listener.');
  }

  return {
    createDocumentCalls: () => createDocumentCalls,
    dispatch: (message) => new Promise<CaptureState>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Service worker response timed out.')), 2_000);
      const keepAlive = listener?.(message, {} as chrome.runtime.MessageSender, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      if (!keepAlive) {
        clearTimeout(timeout);
        reject(new Error('The message channel was not kept alive.'));
      }
    }),
    offscreenMessages,
    requestedUrls,
    releaseErrorWrite,
    releaseStart,
    waitForErrorWriteStarted: () => errorWriteStarted,
    get savedState() {
      return state;
    }
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}
