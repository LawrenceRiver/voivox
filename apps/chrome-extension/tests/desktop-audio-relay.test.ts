import { describe, expect, it, vi } from 'vitest';

import {
  DesktopAudioRelay,
  DesktopAudioRelayError,
  type DesktopTranscriptDelta
} from '../src/desktop-audio-relay.js';

const BRIDGE = {
  baseUrl: 'http://127.0.0.1:43817',
  token: 'restricted-extension-token'
} as const;

describe('DesktopAudioRelay', () => {
  it('starts an authenticated capture bound to the canonical tab URL and tunnel session', async () => {
    const calls: Array<{
      body?: unknown;
      headers: Headers;
      method: string;
      redirect?: RequestRedirect;
      url: string;
    }> = [];
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input, init) => {
        const url = String(input);
        calls.push({
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
          headers: new Headers(init?.headers),
          method: init?.method ?? 'GET',
          redirect: init?.redirect,
          url
        });
        if (url.endsWith('/v1/extension/captures')) {
          return jsonResponse(captureSession());
        }
        return neverResponse(init?.signal);
      }
    });

    await relay.start({
      jobId: 'job-1',
      mode: 'quality',
      tabTitle: 'Target video',
      tabUrl: 'https://example.test/watch/1',
      tunnelSessionId: 'tunnel-1'
    });

    expect(calls[0]).toMatchObject({
      body: {
        jobId: 'job-1',
        mode: 'quality',
        source: {
          kind: 'chrome-tab',
          label: 'Target video',
          title: 'Target video',
          url: 'https://example.test/watch/1'
        },
        tunnelSessionId: 'tunnel-1'
      },
      method: 'POST',
      redirect: 'error',
      url: 'http://127.0.0.1:43817/v1/extension/captures'
    });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer restricted-extension-token');
    relay.cancel();
  });

  it('drains an already accepted partial tail after five full chunks are pending', async () => {
    const audioCalls: Array<{ bytes: number; sequence: number }> = [];
    const releases: Array<() => void> = [];
    let stopPosted = false;
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/extension/captures')) return jsonResponse(captureSession(), 201);
        const audio = url.match(/\/audio\/(\d+)$/u);
        if (audio) {
          audioCalls.push({
            bytes: (init?.body as ArrayBuffer).byteLength,
            sequence: Number(audio[1])
          });
          await new Promise<void>((resolve) => releases.push(resolve));
          return new Response(null, { status: 204 });
        }
        if (url.endsWith('/stop')) {
          stopPosted = true;
          return jsonResponse(captureSession('complete'));
        }
        if (url.includes('/transcript?')) {
          return stopPosted
            ? jsonResponse(transcriptDelta(0, 1, 'complete', []))
            : new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request ${url}`);
      },
      longPollWaitMs: 5
    });
    await relay.start(startInput());
    relay.append(new Float32Array(16_000 * 5 + 8_000).fill(0.1));

    const stopping = relay.stop();
    for (let index = 0; index < 6; index += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index));
      releases[index]?.();
    }

    await expect(stopping).resolves.toMatchObject({ status: 'complete' });
    expect(audioCalls).toEqual([
      { bytes: 32_000, sequence: 0 },
      { bytes: 32_000, sequence: 1 },
      { bytes: 32_000, sequence: 2 },
      { bytes: 32_000, sequence: 3 },
      { bytes: 32_000, sequence: 4 },
      { bytes: 16_000, sequence: 5 }
    ]);
  });

  it('bounds a long page title before publishing it to the desktop service', async () => {
    let body: Record<string, unknown> | undefined;
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/extension/captures')) {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse(captureSession(), 201);
        }
        return neverResponse(init?.signal);
      }
    });

    await relay.start({ ...startInput(), tabTitle: `  ${'T'.repeat(700)}  ` });

    const source = body?.source as Record<string, unknown>;
    expect(source.label).toBe('T'.repeat(500));
    expect(source.title).toBe('T'.repeat(500));
    relay.cancel();
  });

  it('sends exact sequential PCM sequences, drains a partial chunk, and merges ordered transcript deltas', async () => {
    const audioCalls: Array<{ bytes: number; sequence: number }> = [];
    const transcriptDeltas = [
      transcriptDelta(0, 1, 'capturing', [{ startMs: 0, endMs: 900, text: '第一段' }]),
      transcriptDelta(1, 2, 'complete', [{ startMs: 900, endMs: 1_100, text: 'second' }])
    ];
    let stopPosted = false;
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/extension/captures')) return jsonResponse(captureSession(), 201);
        const audio = url.match(/\/audio\/(\d+)$/u);
        if (audio) {
          audioCalls.push({
            bytes: (init?.body as ArrayBuffer).byteLength,
            sequence: Number(audio[1])
          });
          return new Response(null, { status: 204 });
        }
        if (url.endsWith('/stop')) {
          stopPosted = true;
          return jsonResponse(captureSession('complete'));
        }
        if (url.includes('/transcript?')) {
          const delta = transcriptDeltas[0];
          if (!delta || (delta.status === 'complete' && !stopPosted)) {
            return new Response(null, { status: 204 });
          }
          return jsonResponse(transcriptDeltas.shift());
        }
        throw new Error(`Unexpected request ${url}`);
      },
      longPollWaitMs: 5
    });

    await relay.start(startInput());
    relay.append(new Float32Array(16_001).fill(0.25));
    const result = await relay.stop();

    expect(audioCalls).toEqual([
      { bytes: 32_000, sequence: 0 },
      { bytes: 2, sequence: 1 }
    ]);
    expect(result).toMatchObject({
      revision: 2,
      status: 'complete',
      transcript: '第一段\nsecond'
    });
    expect(result.segments.map((segment) => segment.text)).toEqual(['第一段', 'second']);
  });

  it('lets a slow stop inference use the terminal deadline instead of the short request timeout', async () => {
    let releaseStop: (() => void) | undefined;
    let stopPosted = false;
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/extension/captures')) return jsonResponse(captureSession(), 201);
        if (url.endsWith('/stop')) {
          stopPosted = true;
          await new Promise<void>((resolve, reject) => {
            releaseStop = resolve;
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return jsonResponse(captureSession('complete'));
        }
        if (url.includes('/transcript?')) {
          return stopPosted && releaseStop === undefined
            ? jsonResponse(transcriptDelta(0, 1, 'complete', []))
            : new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request ${url}`);
      },
      longPollWaitMs: 5,
      requestTimeoutMs: 10,
      terminalWaitMs: 100
    });
    await relay.start(startInput());

    const stopping = relay.stop();
    await vi.waitFor(() => expect(releaseStop).toBeTypeOf('function'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const finishStop = releaseStop;
    releaseStop = undefined;
    finishStop?.();

    await expect(stopping).resolves.toMatchObject({ status: 'complete' });
  });

  it('reports a stop that exceeds the terminal deadline as inference timeout', async () => {
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/extension/captures')) return jsonResponse(captureSession(), 201);
        if (url.endsWith('/stop')) return neverResponse(init?.signal);
        if (url.includes('/transcript?')) return new Response(null, { status: 204 });
        throw new Error(`Unexpected request ${url}`);
      },
      longPollWaitMs: 5,
      requestTimeoutMs: 5,
      terminalWaitMs: 20
    });
    await relay.start(startInput());

    await expect(relay.stop()).rejects.toMatchObject({ code: 'ASR_INFERENCE_TIMEOUT' });
  });

  it('allows five pending audio chunks and rejects the sixth with stable backpressure', async () => {
    const releases: Array<() => void> = [];
    let activeAudioRequests = 0;
    let maximumActiveAudioRequests = 0;
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/extension/captures')) return jsonResponse(captureSession(), 201);
        if (url.includes('/audio/')) {
          activeAudioRequests += 1;
          maximumActiveAudioRequests = Math.max(maximumActiveAudioRequests, activeAudioRequests);
          await new Promise<void>((resolve) => releases.push(resolve));
          activeAudioRequests -= 1;
          return new Response(null, { status: 204 });
        }
        return neverResponse(init?.signal);
      }
    });
    await relay.start(startInput());

    relay.append(new Float32Array(16_000 * 5).fill(0.1));
    expect(() => relay.append(new Float32Array(16_000).fill(0.1))).toThrowError(
      expect.objectContaining({ code: 'AUDIO_RELAY_BACKPRESSURE' })
    );
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    expect(maximumActiveAudioRequests).toBe(1);

    for (let index = 0; index < 5; index += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index));
      releases[index]?.();
    }
    relay.cancel();
  });

  it('preserves stable server error codes and retryability', async () => {
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/extension/captures')) return jsonResponse(captureSession(), 201);
        if (url.includes('/audio/')) {
          return jsonResponse({
            code: 'AUDIO_SEQUENCE_MISMATCH',
            error: 'The private audio stream arrived out of order.',
            retryable: true
          }, 409);
        }
        if (url.endsWith('/stop')) return jsonResponse(captureSession('complete'));
        return neverResponse(init?.signal);
      }
    });
    await relay.start(startInput());
    relay.append(new Float32Array(16_000));

    await expect(relay.stop()).rejects.toMatchObject({
      code: 'AUDIO_SEQUENCE_MISMATCH',
      retryable: true
    });
  });

  it('rejects transcript deltas whose segments regress on the session timeline', async () => {
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input) => {
        const url = String(input);
        if (url.endsWith('/v1/extension/captures')) return jsonResponse(captureSession(), 201);
        if (url.endsWith('/stop')) return jsonResponse(captureSession('complete'));
        if (url.includes('/transcript?')) {
          return jsonResponse(transcriptDelta(0, 1, 'complete', [
            { startMs: 500, endMs: 900, text: 'later' },
            { startMs: 100, endMs: 400, text: 'earlier' }
          ]));
        }
        throw new Error(`Unexpected request ${url}`);
      }
    });
    await relay.start(startInput());

    await expect(relay.stop()).rejects.toMatchObject({ code: 'ASR_INFERENCE_FAILED' });
  });

  it('aborts the transcript long poll after an audio failure has been drained and stopped', async () => {
    let transcriptSignal: AbortSignal | undefined;
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/extension/captures')) return jsonResponse(captureSession(), 201);
        if (url.includes('/audio/')) {
          return jsonResponse({
            code: 'AUDIO_SEQUENCE_MISMATCH',
            error: 'The private audio stream arrived out of order.',
            retryable: true
          }, 409);
        }
        if (url.endsWith('/stop')) return jsonResponse(captureSession('complete'));
        if (url.includes('/transcript?')) {
          transcriptSignal = init?.signal ?? undefined;
          return neverResponse(init?.signal);
        }
        throw new Error(`Unexpected request ${url}`);
      }
    });
    await relay.start(startInput());
    relay.append(new Float32Array(16_000));
    await vi.waitFor(() => expect(transcriptSignal).toBeDefined());

    await expect(relay.stop()).rejects.toMatchObject({ code: 'AUDIO_SEQUENCE_MISMATCH' });
    expect(transcriptSignal?.aborted).toBe(true);
  });

  it('rejects non-IPv4-loopback bridges before making a request', async () => {
    const fetcher = vi.fn();

    expect(() => new DesktopAudioRelay({
      bridge: { baseUrl: 'http://localhost:43817', token: 'token' },
      fetcher
    })).toThrowError(DesktopAudioRelayError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels a bounded transcript long poll', async () => {
    let observedSignal: AbortSignal | undefined;
    const relay = new DesktopAudioRelay({
      bridge: BRIDGE,
      fetcher: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/v1/extension/captures')) return jsonResponse(captureSession(), 201);
        observedSignal = init?.signal ?? undefined;
        return neverResponse(init?.signal);
      },
      requestTimeoutMs: 50
    });
    await relay.start(startInput());
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    relay.cancel();

    expect(observedSignal?.aborted).toBe(true);
  });
});

function startInput() {
  return {
    mode: 'fast' as const,
    tabTitle: 'Current tab',
    tabUrl: 'https://example.test/watch',
    tunnelSessionId: 'tunnel-1'
  };
}

function captureSession(status: 'capturing' | 'complete' = 'capturing') {
  return {
    createdAt: '2026-07-20T00:00:00.000Z',
    derivedTranscripts: [],
    id: 'session_1',
    rawSegments: [],
    revision: status === 'complete' ? 2 : 0,
    source: { kind: 'chrome-tab', label: 'Current tab', url: 'https://example.test/watch' },
    status
  };
}

function transcriptDelta(
  afterRevision: number,
  revision: number,
  status: DesktopTranscriptDelta['status'],
  appendedSegments: DesktopTranscriptDelta['appendedSegments']
): DesktopTranscriptDelta {
  return { afterRevision, appendedSegments, revision, sessionId: 'session_1', status };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status
  });
}

function neverResponse(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}
