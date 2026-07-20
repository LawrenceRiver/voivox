import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaptureState } from '../src/bridge.js';

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
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
      route: 'desktop-local',
      sessionId: 'lost-session',
      tabTitle: 'Lost tab'
    });

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

    expect(state).toEqual({ active: false, mode: 'quality', phase: 'idle' });
    expect(harness.offscreenMessages).toHaveLength(0);
    expect(harness.savedState).toEqual(state);
  });

  it('owns capture-state storage for the offscreen document', async () => {
    const harness = await createHarness({ active: false, mode: 'quality', phase: 'idle' });
    const capturing: CaptureState = {
      active: true,
      mode: 'fast',
      phase: 'capturing',
      route: 'desktop-local',
      sessionId: 'browser-runtime-state',
      tabTitle: 'Runtime-only offscreen tab'
    };

    const saved = await harness.dispatch({
      state: capturing,
      target: 'service-worker',
      type: 'capture-state:save'
    });
    const loaded = await harness.dispatch({ target: 'service-worker', type: 'capture-state:get' });

    expect(saved).toEqual(capturing);
    expect(loaded).toEqual(capturing);
    expect(harness.savedState).toEqual(capturing);
  });

  it('accepts offscreen state writes while a capture toggle is still running', async () => {
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'idle' },
      false,
      undefined,
      true,
      false,
      false,
      false,
      true
    );

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

    expect(state).toMatchObject({ active: true, phase: 'capturing', route: 'desktop-local' });
    expect(harness.savedState).toEqual(state);
  });

  it('relays Chrome tab audio to the authenticated local App ASR', async () => {
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'idle' },
      false,
      undefined,
      true,
      false,
      false,
      false,
      false,
      'tunnel-1'
    );

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

    expect(harness.offscreenMessages[0]).toMatchObject({
      bridge: {
        baseUrl: 'http://127.0.0.1:43817',
        token: 'restricted-token'
      },
      route: 'desktop-local',
      tunnelSessionId: 'tunnel-1',
      type: 'audio:start'
    });
    expect(state).toMatchObject({ active: true, route: 'desktop-local' });
    expect(harness.requestedUrls).toHaveLength(0);
  });

  it('clears a stale desktop-local state when its offscreen document is gone', async () => {
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

  it('does not capture tab audio while the authenticated local App is unavailable', async () => {
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'idle' },
      false,
      undefined,
      false
    );

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

    expect(state).toMatchObject({ active: false, phase: 'error' });
    expect(harness.streamTabIds).toEqual([]);
    expect(harness.offscreenMessages).toEqual([]);
  });

  it('does not offer a retry after the offscreen audio buffer was reclaimed', async () => {
    const harness = await createHarness({
      active: false,
      canRetry: true,
      error: 'model failed',
      mode: 'quality',
      phase: 'error',
      route: 'desktop-local',
      sessionId: 'lost-buffer'
    });

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:retry' });

    expect(state).toMatchObject({ active: false, canRetry: false, phase: 'error' });
    expect(state.error).toContain('audio');
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
          route: 'desktop-local',
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
      expect(state).toMatchObject({ canRetry: true, phase: 'error', route: 'desktop-local' });
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
      route: 'desktop-local',
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
      true,
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

  it('preserves an exact stable local App start error in CaptureState', async () => {
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'idle' },
      false,
      undefined,
      true,
      true
    );

    const state = await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

    expect(state).toMatchObject({
      active: false,
      canRetry: false,
      errorCode: 'ASR_MODEL_MISSING',
      phase: 'error'
    });
  });

  it('arms on popup request without capture and retains that tab when focus changes', async () => {
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'idle' },
      false,
      undefined,
      true,
      false,
      false,
      false,
      false,
      ''
    );

    const armed = await harness.dispatch({ target: 'service-worker', type: 'tab:arm' }) as unknown as {
      captureState: CaptureState;
      session: { tabId: number; documentId: string; dropToken: string };
    };

    expect(armed.captureState).toMatchObject({ active: false, phase: 'armed', tabTitle: 'Current tab' });
    expect(armed.session).toMatchObject({ tabId: 17, documentId: 'doc-17' });
    expect(armed.session.dropToken).toMatch(/^VOICE_VAC_DROP_V1\|[^|]+\|[A-Za-z0-9_-]{43}$/u);
    expect(harness.createDocumentCalls()).toBe(0);
    expect(harness.streamTabIds).toEqual([]);

    harness.setActiveTab({ id: 99, windowId: 1, title: 'Other tab', url: 'https://other.example/' });
    await harness.dispatch({ target: 'service-worker', type: 'capture:toggle' });

    expect(harness.queryCalls()).toBe(1);
    expect(harness.streamTabIds).toEqual([17]);
  });

  it('returns a structured stable target error for a stale document without an unhandled rejection', async () => {
    const harness = await createHarness({ active: false, mode: 'quality', phase: 'armed' });

    const response = await harness.dispatch(
      { target: 'service-worker', type: 'target:ready' },
      { tab: { id: 17 }, frameId: 0, documentId: 'doc-stale' } as chrome.runtime.MessageSender
    ) as unknown as Record<string, unknown>;

    expect(response).toEqual({
      ok: false,
      error: {
        code: 'TARGET_NAVIGATED',
        message: 'The armed page navigated. Arm the current page again.',
        retryable: true
      }
    });
  });

  it('publishes tab closure to the desktop tunnel and clears stale ready identity', async () => {
    const harness = await createHarness(
      {
        active: false,
        mode: 'quality',
        phase: 'armed',
        tunnelSessionId: 'tunnel-old'
      },
      false, undefined, true, false, false, false, false, 'tunnel-old'
    );

    harness.emitTabRemoved(17);
    await vi.waitFor(() => {
      expect(harness.savedState.phase).toBe('error');
    });

    expect(harness.savedState).toMatchObject({
      active: false,
      errorCode: 'TAB_CLOSED',
      linkState: 'error',
      phase: 'error'
    });
    expect(harness.savedState).not.toHaveProperty('tunnelSessionId');
    const patch = harness.bridgeRequests.find((request) => request.url.includes('/tunnel-old'));
    expect(patch).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({ errorCode: 'TAB_CLOSED', state: 'error' });
  });

  it('publishes navigation with its stable code and removes the old tunnel identity', async () => {
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'armed', tunnelSessionId: 'tunnel-old' },
      false, undefined, true, false, false, false, false, 'tunnel-old'
    );

    harness.emitTabUpdated(17, { status: 'loading' });
    await vi.waitFor(() => expect(harness.savedState.phase).toBe('error'));

    expect(harness.savedState.errorCode).toBe('TARGET_NAVIGATED');
    expect(harness.savedState).not.toHaveProperty('tunnelSessionId');
  });

  it('does not publish a replacement session when old bridge termination fails after capture stop', async () => {
    const harness = await createHarness(
      {
        active: true,
        mode: 'quality',
        phase: 'capturing',
        tunnelSessionId: 'tunnel-old'
      },
      false, undefined, true, false, false, true, false, 'tunnel-old', 503
    );
    const old = harness.targetSession();

    const response = await harness.dispatch({ target: 'service-worker', type: 'tab:arm' }) as unknown as {
      error: string;
      session?: unknown;
    };

    expect(response.session).toBeUndefined();
    expect(harness.offscreenMessages).toContainEqual({ target: 'offscreen', type: 'audio:stop' });
    expect(harness.targetSession()).toEqual(old);
    expect(harness.sentTabMessages).toEqual([{
      sessionId: '2b0fe529-4021-4674-b55e-1cf081f947dd',
      type: 'target-disconnect'
    }]);
    expect(harness.savedState).toMatchObject({ active: false, phase: 'error' });
  });

  it('rejects a replacement when the old audio stop still reports an active track', async () => {
    const stillCapturing: CaptureState = {
      active: true,
      mode: 'quality',
      phase: 'capturing',
      route: 'desktop-local',
      sessionId: 'old-capture'
    };
    const harness = await createHarness(
      stillCapturing,
      false, undefined, false, false, false, true, false, undefined, 200, stillCapturing
    );
    const old = harness.targetSession();

    const response = await harness.dispatch({ target: 'service-worker', type: 'tab:arm' }) as unknown as {
      session?: unknown;
    };

    expect(response.session).toBeUndefined();
    expect(harness.targetSession()).toEqual(old);
    expect(harness.sentTabMessages).toEqual([]);
  });

  it('drains a production-like transcribing stop before replacing and rejects late old-session state', async () => {
    const oldCapture: CaptureState = {
      active: true,
      mode: 'quality',
      phase: 'capturing',
      route: 'desktop-local',
      sessionId: 'old-capture'
    };
    const transcribing: CaptureState = {
      ...oldCapture,
      active: false,
      phase: 'transcribing'
    };
    const harness = await createHarness(
      oldCapture,
      false, undefined, false, false, false, true, false, undefined, 200, transcribing
    );

    const response = await harness.dispatch({ target: 'service-worker', type: 'tab:arm' }) as unknown as {
      captureState: CaptureState;
      session?: unknown;
    };

    expect(response.session).toBeDefined();
    expect(harness.offscreenMessages.map((message) => message.type)).toEqual(['audio:stop', 'audio:cancel']);
    expect(response.captureState).toMatchObject({ active: false, phase: 'armed', tabTitle: 'Current tab' });
    expect(response.captureState).not.toHaveProperty('sessionId');

    const lateOldState: CaptureState = {
      active: false,
      mode: 'quality',
      phase: 'complete',
      route: 'desktop-local',
      sessionId: 'old-capture',
      transcript: 'late old transcript'
    };
    const accepted = await harness.dispatch({
      state: lateOldState,
      target: 'service-worker',
      type: 'capture-state:save'
    });

    expect(accepted).toEqual(response.captureState);
    expect(harness.savedState).toEqual(response.captureState);
  });

  it('retains a failed invalidation tunnel and retries its coded terminal patch before re-arming', async () => {
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'armed', tunnelSessionId: 'tunnel-old' },
      false, undefined, true, false, false, false, false, 'tunnel-old', 503
    );

    harness.emitTabRemoved(17);
    await vi.waitFor(() => expect(harness.savedState.phase).toBe('error'));

    expect(harness.savedState).toMatchObject({
      errorCode: 'TAB_CLOSED',
      phase: 'error',
      tunnelSessionId: 'tunnel-old'
    });
    expect(JSON.parse(harness.bridgeRequests[0]?.body ?? '{}')).toEqual({
      errorCode: 'TAB_CLOSED',
      state: 'error'
    });

    harness.setBridgeStatus(200);
    const response = await harness.dispatch({ target: 'service-worker', type: 'tab:arm' }) as unknown as {
      session?: unknown;
    };

    expect(response.session).toBeDefined();
    expect(harness.bridgeRequests.map((request) => request.method)).toEqual(['PATCH', 'PATCH', 'POST']);
    expect(JSON.parse(harness.bridgeRequests[1]?.body ?? '{}')).toEqual({
      errorCode: 'TAB_CLOSED',
      state: 'error'
    });
  });

  it('drains invalidation transcription and rejects delayed completion without losing failed PATCH retry identity', async () => {
    const oldCapture: CaptureState = {
      active: true,
      mode: 'quality',
      phase: 'capturing',
      route: 'desktop-local',
      sessionId: 'old-capture',
      tunnelSessionId: 'tunnel-old'
    };
    const transcribing: CaptureState = {
      ...oldCapture,
      active: false,
      phase: 'transcribing'
    };
    const harness = await createHarness(
      oldCapture,
      false, undefined, true, false, false, true, false, 'tunnel-old', 503, transcribing
    );

    harness.emitTabRemoved(17);
    await vi.waitFor(() => expect(harness.savedState.errorCode).toBe('TAB_CLOSED'));

    expect(harness.offscreenMessages.map((message) => message.type)).toEqual(['audio:stop', 'audio:cancel']);
    expect(harness.savedState).toMatchObject({
      errorCode: 'TAB_CLOSED',
      phase: 'error',
      sessionId: 'old-capture',
      tunnelSessionId: 'tunnel-old'
    });

    const lateOldState: CaptureState = {
      active: false,
      mode: 'quality',
      phase: 'complete',
      route: 'desktop-local',
      sessionId: 'old-capture',
      transcript: 'late old completion'
    };
    const accepted = await harness.dispatch({
      state: lateOldState,
      target: 'service-worker',
      type: 'capture-state:save'
    });
    expect(accepted).toEqual(harness.savedState);
    expect(harness.savedState).toMatchObject({
      errorCode: 'TAB_CLOSED',
      phase: 'error',
      tunnelSessionId: 'tunnel-old'
    });
    expect(harness.savedState.transcript).not.toBe('late old completion');

    harness.setBridgeStatus(200);
    const rearmed = await harness.dispatch({ target: 'service-worker', type: 'tab:arm' }) as unknown as {
      session?: unknown;
    };
    expect(rearmed.session).toBeDefined();
    expect(harness.bridgeRequests.map((request) => request.method)).toEqual(['PATCH', 'PATCH', 'POST']);
  });

  it('preserves the lifecycle terminal barrier across a failed arm retry before eventual bridge recovery', async () => {
    const oldCapture: CaptureState = {
      active: true,
      mode: 'quality',
      phase: 'capturing',
      route: 'desktop-local',
      sessionId: 'old-capture',
      tunnelSessionId: 'tunnel-old'
    };
    const harness = await createHarness(
      oldCapture,
      false, undefined, true, false, false, true, false, 'tunnel-old', 503,
      { ...oldCapture, active: false, phase: 'transcribing' }
    );

    harness.emitTabRemoved(17);
    await vi.waitFor(() => expect(harness.savedState.errorCode).toBe('TAB_CLOSED'));

    const failedRetry = await harness.dispatch({ target: 'service-worker', type: 'tab:arm' }) as unknown as {
      captureState: CaptureState;
      session?: unknown;
    };
    expect(failedRetry.session).toBeUndefined();
    expect(failedRetry.captureState).toMatchObject({
      errorCode: 'TAB_CLOSED',
      phase: 'error',
      tunnelSessionId: 'tunnel-old'
    });
    expect(harness.savedState).toEqual(failedRetry.captureState);

    const lateOldState: CaptureState = {
      active: false,
      mode: 'quality',
      phase: 'complete',
      route: 'desktop-local',
      sessionId: 'old-capture',
      transcript: 'late after retry failure'
    };
    const rejectedLateState = await harness.dispatch({
      state: lateOldState,
      target: 'service-worker',
      type: 'capture-state:save'
    });
    expect(rejectedLateState).toEqual(failedRetry.captureState);
    expect(harness.savedState).toEqual(failedRetry.captureState);

    harness.setBridgeStatus(200);
    const rearmed = await harness.dispatch({ target: 'service-worker', type: 'tab:arm' }) as unknown as {
      session?: unknown;
    };
    expect(rearmed.session).toBeDefined();
    expect(harness.bridgeRequests.map((request) => request.method)).toEqual([
      'PATCH', 'PATCH', 'PATCH', 'POST'
    ]);
    for (const request of harness.bridgeRequests.slice(0, 3)) {
      expect(JSON.parse(request.body)).toEqual({ errorCode: 'TAB_CLOSED', state: 'error' });
    }
  });

  it('terminates the old desktop tunnel before creating the replacement bridge session', async () => {
    const harness = await createHarness(
      { active: false, mode: 'quality', phase: 'armed', tunnelSessionId: 'tunnel-old' },
      false, undefined, true, false, false, false, false, 'tunnel-old'
    );

    const response = await harness.dispatch({ target: 'service-worker', type: 'tab:arm' }) as unknown as {
      session?: unknown;
    };

    expect(response.session).toBeDefined();
    expect(harness.bridgeRequests.map((request) => request.url)).toEqual([
      'http://127.0.0.1:43817/v1/extension/tunnel-sessions/tunnel-old',
      'http://127.0.0.1:43817/v1/extension/tunnel-sessions'
    ]);
    expect(JSON.parse(harness.bridgeRequests[0]!.body)).toEqual({
      errorCode: 'TARGET_NAVIGATED',
      state: 'error'
    });
    expect(JSON.parse(harness.bridgeRequests[1]!.body)).toMatchObject({
      tabId: 17,
      frameId: 0,
      documentId: 'doc-17'
    });
  });
});

async function createHarness(
  initialState: CaptureState,
  delayStart = false,
  stateAfterStart?: CaptureState,
  nativeDesktopReady = true,
  failFirstStart = false,
  delayErrorWrite = false,
  initialHasOffscreenDocument = false,
  publishStateDuringStart = false,
  targetTunnelSessionId?: string,
  bridgeStatus = 200,
  stateAfterStop?: CaptureState
): Promise<{
  createDocumentCalls: () => number;
  dispatch: (message: unknown, sender?: chrome.runtime.MessageSender) => Promise<CaptureState>;
  bridgeRequests: Array<{ body: string; method: string; url: string }>;
  emitTabRemoved: (tabId: number) => void;
  emitTabUpdated: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void;
  offscreenMessages: Array<Record<string, unknown>>;
  requestedUrls: string[];
  queryCalls: () => number;
  setActiveTab: (tab: Pick<chrome.tabs.Tab, 'id' | 'windowId' | 'title' | 'url'>) => void;
  setBridgeStatus: (status: number) => void;
  sentTabMessages: unknown[];
  streamTabIds: number[];
  releaseStart: () => void;
  releaseErrorWrite: () => void;
  waitForErrorWriteStarted: () => Promise<void>;
  targetSession: () => unknown;
  readonly savedState: CaptureState;
}> {
  let listener: RuntimeListener | undefined;
  let state = initialState;
  const extraStorage: Record<string, unknown> = {};
  let hasOffscreenDocument = initialHasOffscreenDocument;
  let nativeReady = nativeDesktopReady;
  let currentBridgeStatus = bridgeStatus;
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
  const bridgeRequests: Array<{ body: string; method: string; url: string }> = [];
  let tabRemovedListener: ((tabId: number) => void) | undefined;
  let tabUpdatedListener: ((tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void) | undefined;
  const sentTabMessages: unknown[] = [];
  const streamTabIds: number[] = [];
  let queryCalls = 0;
  let activeTab: Pick<chrome.tabs.Tab, 'id' | 'windowId' | 'title' | 'url'> = {
    id: 17,
    windowId: 1,
    title: 'Current tab',
    url: 'https://video.example/watch'
  };
  const sessionValues: Record<string, unknown> = {
    'voiceVacTargetSession.v1': {
      schemaVersion: 1,
      id: '2b0fe529-4021-4674-b55e-1cf081f947dd',
      tabId: 17,
      windowId: 1,
      frameId: 0,
      documentId: 'doc-17',
      pageOrigin: 'https://video.example',
      url: 'https://video.example/watch',
      title: 'Current tab',
      dropNonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      dropToken: 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      status: 'armed',
      armedAt: 1,
      updatedAt: 1,
      ...(targetTunnelSessionId === ''
        ? {}
        : targetTunnelSessionId
        ? { tunnelSessionId: targetTunnelSessionId }
        : nativeDesktopReady
          ? { tunnelSessionId: 'tunnel-default' }
          : {})
    }
  };

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
            return {
              error: 'The local Qwen3-ASR model is not installed.',
              errorCode: 'ASR_MODEL_MISSING',
              retryable: false
            };
          }
          const startedState = stateAfterStart ?? {
            active: true,
            mode: message.mode === 'fast' ? 'fast' : 'quality',
            phase: 'capturing',
            route: 'desktop-local',
            sessionId: 'browser-session',
            tabTitle: 'Current tab',
            tunnelSessionId: message.tunnelSessionId as string
          };
          if (publishStateDuringStart) {
            await new Promise<CaptureState>((resolve, reject) => {
              const timeout = setTimeout(() => reject(new Error('Nested state write timed out.')), 250);
              const keepAlive = listener?.(
                { state: startedState, target: 'service-worker', type: 'capture-state:save' },
                {} as chrome.runtime.MessageSender,
                (response) => {
                  clearTimeout(timeout);
                  resolve(response as CaptureState);
                }
              );
              if (!keepAlive) {
                clearTimeout(timeout);
                reject(new Error('Nested state write did not keep the channel alive.'));
              }
            });
          } else {
            state = startedState;
          }
          return { sessionId: 'browser-session' };
        }
        if (message.type === 'audio:cancel') {
          state = {
            ...state,
            active: false,
            canRetry: true,
            error: 'transcription cancelled',
            phase: 'error',
            route: 'desktop-local'
          };
          return { state };
        }
        if (message.type === 'audio:stop' && stateAfterStop) {
          state = stateAfterStop;
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
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionValues[key] })),
        remove: vi.fn(async (key: string) => { delete sessionValues[key]; }),
        set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(sessionValues, items); })
      }
    },
    tabCapture: {
      getMediaStreamId: vi.fn((options: { targetTabId: number }, callback: (streamId: string) => void) => {
        streamTabIds.push(options.targetTabId);
        callback('stream-id');
      })
    },
    scripting: {
      executeScript: vi.fn(async () => [{ documentId: 'doc-17', frameId: 0 }])
    },
    tabs: {
      onRemoved: { addListener: vi.fn((registered: (tabId: number) => void) => { tabRemovedListener = registered; }) },
      onReplaced: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn((registered: typeof tabUpdatedListener) => { tabUpdatedListener = registered; }) },
      query: vi.fn(async () => {
        queryCalls += 1;
        return [activeTab];
      }),
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        sentTabMessages.push(message);
        return undefined;
      })
    }
  };
  vi.stubGlobal('chrome', chromeStub);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    requestedUrls.push(String(input));
    bridgeRequests.push({
      body: typeof init?.body === 'string' ? init.body : '',
      method: init?.method ?? 'GET',
      url: String(input)
    });
    return new Response(
      JSON.stringify({ id: targetTunnelSessionId || 'tunnel-created' }),
      { status: currentBridgeStatus }
    );
  }));
  await import('../src/service-worker.js');
  if (!listener) {
    throw new Error('The service worker did not register a runtime listener.');
  }

  return {
    createDocumentCalls: () => createDocumentCalls,
    dispatch: (message, sender = {} as chrome.runtime.MessageSender) => new Promise<CaptureState>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Service worker response timed out.')), 2_000);
      const keepAlive = listener?.(message, sender, (response) => {
        clearTimeout(timeout);
        resolve(response as CaptureState);
      });
      if (!keepAlive) {
        clearTimeout(timeout);
        reject(new Error('The message channel was not kept alive.'));
      }
    }),
    bridgeRequests,
    emitTabRemoved: (tabId) => { tabRemovedListener?.(tabId); },
    emitTabUpdated: (tabId, changeInfo) => { tabUpdatedListener?.(tabId, changeInfo); },
    offscreenMessages,
    queryCalls: () => queryCalls,
    requestedUrls,
    releaseErrorWrite,
    releaseStart,
    setBridgeStatus: (status) => { currentBridgeStatus = status; },
    setActiveTab: (tab) => { activeTab = tab; },
    sentTabMessages,
    streamTabIds,
    waitForErrorWriteStarted: () => errorWriteStarted,
    targetSession: () => structuredClone(sessionValues['voiceVacTargetSession.v1']),
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
