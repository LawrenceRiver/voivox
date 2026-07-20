import { describe, expect, it } from 'vitest';

import {
  CrossWindowSessionStore,
  VoiceVacError,
  VoivoxService,
  type CaptureSession
} from '@voivox/core';
import {
  ExtensionCaptureController,
  type ExtensionPcmPipeline
} from '../src/main/extension-capture-controller.js';

const DROP_TOKEN = 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('ExtensionCaptureController', () => {
  it('binds one Chrome capture to the exact ready tunnel and optional job', () => {
    const service = new VoivoxService();
    const tunnels = new CrossWindowSessionStore();
    const tunnel = tunnels.create(9, {
      documentId: 'document-9',
      dropToken: DROP_TOKEN,
      frameId: 0,
      state: 'detecting',
      title: 'Target MV',
      url: 'https://example.test/mv'
    });
    const harness = pipelineHarness();
    const controller = new ExtensionCaptureController({
      pipeline: harness.pipeline,
      service,
      tunnelSessions: tunnels
    });

    expect(() => controller.startCapture({
      jobId: 'job-9',
      mode: 'fast',
      source: { kind: 'chrome-tab', label: 'Target MV' },
      tunnelSessionId: tunnel.id
    })).toThrowError(expect.objectContaining({ code: 'TAB_NOT_ARMED' }));

    tunnels.update(tunnel.id, { state: 'ready' });
    expect(() => controller.startCapture({
      mode: 'fast',
      source: { kind: 'chrome-tab', label: 'Target MV' },
      tunnelSessionId: tunnel.id
    })).toThrowError(expect.objectContaining({ code: 'TARGET_NAVIGATED' }));
    expect(() => controller.startCapture({
      mode: 'fast',
      source: {
        kind: 'chrome-tab',
        label: 'Target MV',
        url: 'https://example.test/another-video'
      },
      tunnelSessionId: tunnel.id
    })).toThrowError(expect.objectContaining({ code: 'TARGET_NAVIGATED' }));

    const session = controller.startCapture({
      jobId: 'job-9',
      mode: 'fast',
      source: {
        kind: 'chrome-tab',
        label: 'Target MV',
        language: 'zh',
        title: 'Target MV',
        url: 'https://example.test/mv'
      },
      tunnelSessionId: tunnel.id
    });

    expect(session).toMatchObject({
      source: {
        kind: 'chrome-tab',
        label: 'Target MV',
        url: 'https://example.test/mv'
      },
      status: 'capturing'
    });
    expect(controller.getBinding(session.id)).toEqual({
      canonicalUrl: 'https://example.test/mv',
      captureSessionId: session.id,
      documentId: 'document-9',
      frameId: 0,
      jobId: 'job-9',
      nextSequence: 0,
      receivedBytes: 0,
      stopping: false,
      tabId: 9,
      tunnelSessionId: tunnel.id
    });
    expect(harness.configured).toEqual([{ sessionId: session.id, mode: 'fast' }]);
    expect(() => controller.startCapture({
      mode: 'quality',
      source: { kind: 'macos-process', label: 'Safari' } as never,
      tunnelSessionId: tunnel.id
    })).toThrow(/Chrome tab/i);
  });

  it('condition-waits for the exact MCP job binding without selecting another capture', async () => {
    const { controller, tunnelId } = readyController();
    const waiting = controller.waitForJob('job-exact', 100);

    const unrelated = controller.startCapture({
      jobId: 'job-other',
      mode: 'quality',
      source: {
        kind: 'chrome-tab',
        label: 'Target MV',
        url: 'https://example.test/mv'
      },
      tunnelSessionId: tunnelId
    });
    expect(controller.getBindingForJob('job-exact')).toBeUndefined();
    expect(controller.getBindingForJob('job-other')?.captureSessionId).toBe(unrelated.id);

    // The service enforces one active capture, so finish the unrelated one before
    // registering the exact job that the waiter must resolve with.
    controller.ingestAudio(unrelated.id, 0, new Uint8Array([0, 0]));
    await controller.stopCapture(unrelated.id);
    const exact = controller.startCapture({
      jobId: 'job-exact',
      mode: 'fast',
      source: {
        kind: 'chrome-tab',
        label: 'Target MV',
        url: 'https://example.test/mv'
      },
      tunnelSessionId: tunnelId
    });

    await expect(waiting).resolves.toMatchObject({
      captureSessionId: exact.id,
      jobId: 'job-exact'
    });
    await expect(controller.waitForJob('job-missing', 1)).resolves.toBeUndefined();
  });

  it('requires an exact canonical HTTP URL on both the ready tunnel and capture source', () => {
    const service = new VoivoxService();
    const tunnels = new CrossWindowSessionStore();
    const tunnel = tunnels.create(9, {
      documentId: 'document-9',
      dropToken: DROP_TOKEN,
      frameId: 0,
      state: 'ready'
    });
    const harness = pipelineHarness();
    const controller = new ExtensionCaptureController({
      pipeline: harness.pipeline,
      service,
      tunnelSessions: tunnels
    });

    expect(() => controller.startCapture({
      mode: 'fast',
      source: { kind: 'chrome-tab', label: 'Target MV' },
      tunnelSessionId: tunnel.id
    } as never)).toThrowError(expect.objectContaining({ code: 'TAB_NOT_ARMED' }));

    tunnels.update(tunnel.id, { url: 'file:///tmp/video.mp4' });
    expect(() => controller.startCapture({
      mode: 'fast',
      source: { kind: 'chrome-tab', label: 'Target MV', url: 'file:///tmp/video.mp4' },
      tunnelSessionId: tunnel.id
    })).toThrowError(expect.objectContaining({ code: 'TAB_NOT_ARMED' }));

    tunnels.update(tunnel.id, { url: 'https://example.test/mv' });
    for (const url of [undefined, '', 'https://example.test/another-mv']) {
      expect(() => controller.startCapture({
        mode: 'fast',
        source: {
          kind: 'chrome-tab',
          label: 'Target MV',
          ...(url === undefined ? {} : { url })
        },
        tunnelSessionId: tunnel.id
      } as never)).toThrowError(expect.objectContaining({ code: 'TARGET_NAVIGATED' }));
    }

    expect(startReadyCapture(controller, tunnel.id)).toMatchObject({ status: 'capturing' });
  });

  it('accepts PCM only in an exact sequence beginning at zero', () => {
    const { controller, harness, tunnelId } = readyController();
    const session = startReadyCapture(controller, tunnelId);

    controller.ingestAudio(session.id, 0, new Uint8Array([0, 0, 1, 0]));
    expect(() => controller.ingestAudio(
      session.id,
      2,
      new Uint8Array([2, 0])
    )).toThrowError(expect.objectContaining({ code: 'AUDIO_SEQUENCE_MISMATCH' }));
    expect(controller.getBinding(session.id)).toMatchObject({
      nextSequence: 1,
      receivedBytes: 4
    });

    controller.ingestAudio(session.id, 1, new Uint8Array([2, 0]));
    expect(controller.getBinding(session.id)).toMatchObject({
      nextSequence: 2,
      receivedBytes: 6
    });
    expect(harness.ingested).toEqual([
      { sessionId: session.id, pcm: [0, 0, 1, 0], sampleRate: 16_000, channels: 1 },
      { sessionId: session.id, pcm: [2, 0], sampleRate: 16_000, channels: 1 }
    ]);
  });

  it('flushes every accepted byte through the pipeline before completing', async () => {
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { controller, harness, service, tunnelId } = readyController({
      finish: () => finishing
    });
    const session = startReadyCapture(controller, tunnelId);
    controller.ingestAudio(session.id, 0, new Uint8Array([0, 0]));

    const stopping = controller.stopCapture(session.id);
    await Promise.resolve();
    expect(service.getSession(session.id)?.status).toBe('capturing');
    expect(controller.getBinding(session.id)?.stopping).toBe(true);
    expect(harness.finished).toEqual([session.id]);

    finish();
    await expect(stopping).resolves.toMatchObject({ status: 'complete' });
    expect(service.getSession(session.id)?.status).toBe('complete');
  });

  it('rejects the old page when its tunnel navigates during the final Qwen flush', async () => {
    let finish!: () => void;
    const finishing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { controller, service, tunnelId, tunnels } = readyController({
      finish: () => finishing
    });
    const session = startReadyCapture(controller, tunnelId);
    controller.ingestAudio(session.id, 0, new Uint8Array([0, 0]));

    const stopping = controller.stopCapture(session.id);
    await Promise.resolve();
    tunnels.update(tunnelId, {
      errorCode: 'TARGET_NAVIGATED',
      state: 'error',
      url: 'https://example.test/navigated'
    });
    finish();

    await expect(stopping).rejects.toMatchObject({ code: 'TARGET_NAVIGATED' });
    expect(service.getSession(session.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'TARGET_NAVIGATED' }
    });
    expect(service.getActiveSession()).toBeUndefined();
  });

  it('publishes a stable zero-audio failure instead of a false completion', async () => {
    const { controller, harness, service, tunnelId } = readyController();
    const session = startReadyCapture(controller, tunnelId);

    await expect(controller.stopCapture(session.id)).rejects.toMatchObject({
      code: 'NO_AUDIO_AFTER_TIMEOUT',
      httpStatus: 408,
      retryable: true
    });
    expect(harness.finished).toEqual([session.id]);
    expect(service.getSession(session.id)).toMatchObject({
      status: 'failed',
      failure: {
        code: 'NO_AUDIO_AFTER_TIMEOUT',
        retryable: true
      }
    });
  });

  it('does not let an unknown or closing session reach the PCM pipeline', async () => {
    let finish!: () => void;
    const { controller, harness, tunnelId } = readyController({
      finish: () => new Promise<void>((resolve) => {
        finish = resolve;
      })
    });
    const session = startReadyCapture(controller, tunnelId);

    expect(() => controller.ingestAudio(
      'session-from-another-client',
      0,
      new Uint8Array([0, 0])
    )).toThrowError(expect.objectContaining({ code: 'STREAM_ENDED' }));
    const stopping = controller.stopCapture(session.id);
    expect(() => controller.ingestAudio(
      session.id,
      0,
      new Uint8Array([0, 0])
    )).toThrowError(expect.objectContaining({ code: 'STREAM_ENDED' }));
    expect(harness.ingested).toEqual([]);
    finish();
    await expect(stopping).rejects.toMatchObject({ code: 'NO_AUDIO_AFTER_TIMEOUT' });
  });

  it('delegates transcript condition waits to the bound capture only', async () => {
    const { controller, service, tunnelId } = readyController();
    const session = startReadyCapture(controller, tunnelId);

    expect(controller.getTranscriptRevision(session.id)).toBe(0);
    const abortController = new AbortController();
    const abandoned = controller.waitForTranscript(
      session.id,
      0,
      25_000,
      abortController.signal
    );
    abortController.abort();
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });

    await expect(controller.waitForTranscript(session.id, 0, 1)).resolves.toBeUndefined();
    service.appendRawSegment(session.id, { startMs: 0, endMs: 500, text: 'revision one' });
    await expect(controller.waitForTranscript(session.id, 0, 25_000)).resolves.toMatchObject({
      sessionId: session.id,
      afterRevision: 0,
      revision: 1,
      appendedSegments: [{ text: 'revision one' }]
    });
    await expect(controller.waitForTranscript('foreign-session', 0, 1)).rejects.toMatchObject({
      code: 'STREAM_ENDED'
    });
  });

  it('revalidates an active tunnel before a transcript revision read and retains the failed final poll', async () => {
    const { controller, service, tunnelId, tunnels } = readyController();
    const session = startReadyCapture(controller, tunnelId);
    tunnels.close(tunnelId);

    expect(() => controller.getTranscriptRevision(session.id)).toThrowError(
      expect.objectContaining({ code: 'TAB_CLOSED' })
    );
    expect(service.getActiveSession()).toBeUndefined();
    expect(controller.getTranscriptRevision(session.id)).toBe(1);
    await expect(controller.waitForTranscript(session.id, 0, 1)).resolves.toMatchObject({
      revision: 1,
      status: 'failed',
      failure: { code: 'TAB_CLOSED' }
    });
  });

  it('revalidates URL navigation after a transcript wait without blocking final polling', async () => {
    const { controller, service, tunnelId, tunnels } = readyController();
    const session = startReadyCapture(controller, tunnelId);

    const waiting = controller.waitForTranscript(session.id, 0, 5);
    tunnels.update(tunnelId, { url: 'https://example.test/navigated' });

    await expect(waiting).rejects.toMatchObject({ code: 'TARGET_NAVIGATED' });
    expect(service.getSession(session.id)).toMatchObject({
      revision: 1,
      status: 'failed',
      failure: { code: 'TARGET_NAVIGATED' }
    });
    expect(service.getActiveSession()).toBeUndefined();
    await expect(controller.waitForTranscript(session.id, 0, 1)).resolves.toMatchObject({
      revision: 1,
      status: 'failed',
      failure: { code: 'TARGET_NAVIGATED' }
    });
  });

  it('terminalizes a capture when its bound document navigates before more PCM arrives', () => {
    const { controller, harness, service, tunnelId, tunnels } = readyController();
    const session = startReadyCapture(controller, tunnelId);

    tunnels.update(tunnelId, { state: 'transcribing' });
    controller.ingestAudio(session.id, 0, new Uint8Array([0, 0]));
    tunnels.update(tunnelId, {
      errorCode: 'TARGET_NAVIGATED',
      state: 'error'
    });

    expect(() => controller.ingestAudio(
      session.id,
      1,
      new Uint8Array([1, 0])
    )).toThrowError(expect.objectContaining({ code: 'TARGET_NAVIGATED' }));
    expect(harness.ingested).toHaveLength(1);
    expect(service.getSession(session.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'TARGET_NAVIGATED' }
    });
    expect(service.getActiveSession()).toBeUndefined();

    const replacement = createReadyTunnel(tunnels, 10, 'document-10', 'https://example.test/new-mv');
    expect(controller.startCapture({
      mode: 'fast',
      source: { kind: 'chrome-tab', label: 'New MV', url: replacement.url },
      tunnelSessionId: replacement.id
    })).toMatchObject({ status: 'capturing' });
  });

  it('terminalizes a capture with TAB_CLOSED before stop and keeps stop idempotent', async () => {
    const { controller, service, tunnelId, tunnels } = readyController();
    const session = startReadyCapture(controller, tunnelId);
    controller.ingestAudio(session.id, 0, new Uint8Array([0, 0]));
    tunnels.close(tunnelId);

    const firstStop = controller.stopCapture(session.id);
    const secondStop = controller.stopCapture(session.id);
    expect(firstStop).toBe(secondStop);
    await expect(firstStop).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    await expect(secondStop).rejects.toMatchObject({ code: 'TAB_CLOSED' });
    expect(service.getSession(session.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'TAB_CLOSED' }
    });
    expect(service.getActiveSession()).toBeUndefined();
  });

  it('normalizes pipeline configure failures and releases the active capture', () => {
    let shouldFail = true;
    const { controller, service, tunnelId } = readyController({
      configure: () => {
        if (shouldFail) throw new Error('private runtime detail');
      }
    });

    expect(() => startReadyCapture(controller, tunnelId)).toThrowError(
      expect.objectContaining({ code: 'ASR_INFERENCE_FAILED' })
    );
    expect(service.getActiveSession()).toBeUndefined();
    expect(service.listSessions()[0]).toMatchObject({
      status: 'failed',
      failure: { code: 'ASR_INFERENCE_FAILED' }
    });

    shouldFail = false;
    expect(startReadyCapture(controller, tunnelId)).toMatchObject({ status: 'capturing' });
  });

  it('normalizes pipeline finish failures, preserves an idempotent result, and can restart', async () => {
    let shouldFail = true;
    const { controller, service, tunnelId } = readyController({
      finish: async () => {
        if (shouldFail) throw new Error('private inference detail');
      }
    });
    const session = startReadyCapture(controller, tunnelId);
    controller.ingestAudio(session.id, 0, new Uint8Array([0, 0]));

    const firstStop = controller.stopCapture(session.id);
    const secondStop = controller.stopCapture(session.id);
    expect(firstStop).toBe(secondStop);
    await expect(firstStop).rejects.toMatchObject({ code: 'ASR_INFERENCE_FAILED' });
    await expect(secondStop).rejects.toMatchObject({ code: 'ASR_INFERENCE_FAILED' });
    expect(service.getSession(session.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'ASR_INFERENCE_FAILED' }
    });
    expect(service.getActiveSession()).toBeUndefined();

    shouldFail = false;
    expect(startReadyCapture(controller, tunnelId)).toMatchObject({ status: 'capturing' });
  });

  it('preserves a stable typed failure emitted while the pipeline finishes', async () => {
    const { controller, service, tunnelId } = readyController({
      finish: async () => {
        throw new VoiceVacError('ASR_INFERENCE_TIMEOUT');
      }
    });
    const session = startReadyCapture(controller, tunnelId);
    controller.ingestAudio(session.id, 0, new Uint8Array([0, 0]));

    await expect(controller.stopCapture(session.id)).rejects.toMatchObject({
      code: 'ASR_INFERENCE_TIMEOUT'
    });
    expect(service.getSession(session.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'ASR_INFERENCE_TIMEOUT' }
    });
  });

  it('synchronizes an asynchronous service failure before more PCM and preserves idempotent stop', async () => {
    const { controller, harness, service, tunnelId } = readyController();
    const session = startReadyCapture(controller, tunnelId);
    controller.ingestAudio(session.id, 0, new Uint8Array([0, 0]));
    service.failCapture(session.id, {
      code: 'ASR_MODEL_MISSING',
      message: 'The local Qwen3-ASR model is not installed.',
      retryable: false
    });

    expect(controller.getTranscriptRevision(session.id)).toBe(1);
    expect(() => controller.ingestAudio(
      session.id,
      1,
      new Uint8Array([1, 0])
    )).toThrowError(expect.objectContaining({ code: 'ASR_MODEL_MISSING' }));
    expect(harness.ingested).toHaveLength(1);
    expect(harness.finished).toEqual([session.id]);

    const firstStop = controller.stopCapture(session.id);
    const secondStop = controller.stopCapture(session.id);
    expect(firstStop).toBe(secondStop);
    await expect(firstStop).rejects.toMatchObject({ code: 'ASR_MODEL_MISSING' });
    await expect(secondStop).rejects.toMatchObject({ code: 'ASR_MODEL_MISSING' });
    expect(startReadyCapture(controller, tunnelId)).toMatchObject({ status: 'capturing' });
  });

  it('retains only the newest 32 terminal capture bindings for final transcript polls', async () => {
    const { controller, tunnelId } = readyController();
    const terminalSessions: CaptureSession[] = [];

    for (let index = 0; index < 33; index += 1) {
      const session = startReadyCapture(controller, tunnelId);
      controller.ingestAudio(session.id, 0, new Uint8Array([index, 0]));
      await controller.stopCapture(session.id);
      terminalSessions.push(session);
    }

    expect(controller.hasCapture(terminalSessions[0]!.id)).toBe(false);
    expect(controller.hasCapture(terminalSessions[1]!.id)).toBe(true);
    const newest = terminalSessions.at(-1)!;
    await expect(controller.waitForTranscript(newest.id, 0, 1)).resolves.toMatchObject({
      sessionId: newest.id,
      status: 'complete'
    });
  });

  it('applies the 32-binding terminal limit to asynchronous service failures', async () => {
    const { controller, service, tunnelId } = readyController();
    const terminalSessions: CaptureSession[] = [];

    for (let index = 0; index < 33; index += 1) {
      const session = startReadyCapture(controller, tunnelId);
      service.failCapture(session.id, {
        code: 'ASR_INFERENCE_TIMEOUT',
        message: 'Local speech recognition did not finish in time.',
        retryable: true
      });
      expect(controller.getTranscriptRevision(session.id)).toBe(1);
      terminalSessions.push(session);
    }

    expect(controller.hasCapture(terminalSessions[0]!.id)).toBe(false);
    expect(controller.hasCapture(terminalSessions[1]!.id)).toBe(true);
    const newest = terminalSessions.at(-1)!;
    await expect(controller.waitForTranscript(newest.id, 0, 1)).resolves.toMatchObject({
      sessionId: newest.id,
      status: 'failed',
      failure: { code: 'ASR_INFERENCE_TIMEOUT' }
    });
  });
});

function readyController(overrides: {
  configure?: (sessionId: string, mode: 'fast' | 'quality') => void;
  finish?: (sessionId: string) => Promise<void>;
} = {}): {
  controller: ExtensionCaptureController;
  harness: ReturnType<typeof pipelineHarness>;
  service: VoivoxService;
  tunnelId: string;
  tunnels: CrossWindowSessionStore;
} {
  const service = new VoivoxService();
  const tunnels = new CrossWindowSessionStore();
  const tunnel = tunnels.create(9, {
    documentId: 'document-9',
    dropToken: DROP_TOKEN,
    frameId: 0,
    state: 'ready',
    title: 'Target MV',
    url: 'https://example.test/mv'
  });
  const harness = pipelineHarness(overrides);
  return {
    controller: new ExtensionCaptureController({
      pipeline: harness.pipeline,
      service,
      tunnelSessions: tunnels
    }),
    harness,
    service,
    tunnelId: tunnel.id,
    tunnels
  };
}

function startReadyCapture(
  controller: ExtensionCaptureController,
  tunnelSessionId: string
): CaptureSession {
  return controller.startCapture({
    mode: 'quality',
    source: {
      kind: 'chrome-tab',
      label: 'Target MV',
      url: 'https://example.test/mv'
    },
    tunnelSessionId
  });
}

function pipelineHarness(overrides: {
  configure?: (sessionId: string, mode: 'fast' | 'quality') => void;
  finish?: (sessionId: string) => Promise<void>;
} = {}): {
  configured: Array<{ sessionId: string; mode: 'fast' | 'quality' }>;
  finished: string[];
  ingested: Array<{
    sessionId: string;
    pcm: number[];
    sampleRate: number;
    channels: number;
  }>;
  pipeline: ExtensionPcmPipeline;
} {
  const configured: Array<{ sessionId: string; mode: 'fast' | 'quality' }> = [];
  const finished: string[] = [];
  const ingested: Array<{
    sessionId: string;
    pcm: number[];
    sampleRate: number;
    channels: number;
  }> = [];
  return {
    configured,
    finished,
    ingested,
    pipeline: {
      configureSession: (sessionId, mode) => {
        configured.push({ sessionId, mode });
        overrides.configure?.(sessionId, mode);
      },
      finish: async (sessionId) => {
        finished.push(sessionId);
        await overrides.finish?.(sessionId);
      },
      ingest: (chunk) => ingested.push({
        sessionId: chunk.sessionId,
        pcm: [...chunk.pcm],
        sampleRate: chunk.sampleRate,
        channels: chunk.channels
      })
    }
  };
}

function createReadyTunnel(
  tunnels: CrossWindowSessionStore,
  tabId: number,
  documentId: string,
  url: string
): ReturnType<CrossWindowSessionStore['create']> {
  return tunnels.create(tabId, {
    documentId,
    dropToken: DROP_TOKEN,
    frameId: 0,
    state: 'ready',
    title: 'Replacement MV',
    url
  });
}
