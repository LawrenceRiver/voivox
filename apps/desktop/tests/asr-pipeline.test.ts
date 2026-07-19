import { describe, expect, it } from 'vitest';

import { VoiceVacError, VoivoxService } from '@voivox/core';
import { BufferedAsrPipeline } from '../src/main/asr-pipeline.js';

describe('BufferedAsrPipeline', () => {
  it('atomically closes ingestion while finish drains every accepted window', async () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'chrome-tab', label: 'Closing tab' });
    let resolveFirst!: (value: { text: string }) => void;
    const engine = {
      transcribe: () => new Promise<{ text: string }>((resolve) => {
        resolveFirst = resolve;
      })
    };
    const pipeline = new BufferedAsrPipeline(service, engine, { minimumWindowMs: 1_000 });
    const firstChunk = {
      sessionId: session.id,
      pcm: new Uint8Array(32_000),
      sampleRate: 16_000 as const,
      channels: 1 as const
    };
    pipeline.ingest(firstChunk);
    await Promise.resolve();

    const finishing = pipeline.finish(session.id);

    expect(() => pipeline.ingest(firstChunk)).toThrow(/finishing/i);
    resolveFirst({ text: 'accepted before finish' });
    await finishing;
    expect(service.getSession(session.id)?.rawSegments).toEqual([
      { startMs: 0, endMs: 1_000, text: 'accepted before finish' }
    ]);
  });

  it('turns a completed local PCM window into a timestamped immutable raw segment', async () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'chrome-tab', label: 'Current tab' });
    const engine = {
      transcribe: async () => ({ text: '声音已经在本机转成文字。' })
    };
    const pipeline = new BufferedAsrPipeline(service, engine, { minimumWindowMs: 1_000 });

    pipeline.ingest({
      sessionId: session.id,
      pcm: new Uint8Array(32_000),
      sampleRate: 16_000,
      channels: 1
    });
    await pipeline.finish(session.id);

    expect(service.getSession(session.id)?.rawSegments).toEqual([
      { startMs: 0, endMs: 1_000, text: '声音已经在本机转成文字。' }
    ]);
  });

  it('publishes a failed revision and rejects finish when local inference fails', async () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'chrome-tab', label: 'Current tab' });
    const errors: string[] = [];
    const pipeline = new BufferedAsrPipeline(
      service,
      {
        transcribe: async () => Promise.reject(
          new VoiceVacError('ASR_MODEL_MISSING')
        )
      },
      { minimumWindowMs: 1_000, onError: (error) => errors.push(error.message) }
    );

    pipeline.ingest({
      sessionId: session.id,
      pcm: new Uint8Array(32_000),
      sampleRate: 16_000,
      channels: 1
    });

    await expect(pipeline.finish(session.id)).rejects.toMatchObject({
      code: 'ASR_MODEL_MISSING'
    });
    expect(errors).toEqual(['The local Qwen3-ASR model is not installed.']);
    expect(service.getSession(session.id)).toMatchObject({
      revision: 1,
      status: 'failed',
      failure: {
        code: 'ASR_MODEL_MISSING',
        retryable: false
      }
    });
  });

  it('keeps fast four-second and quality eight-second windows per session', async () => {
    const service = new VoivoxService();
    const fast = service.startCapture({ kind: 'chrome-tab', label: 'Fast tab' });
    const pipeline = new BufferedAsrPipeline(
      service,
      { transcribe: async () => ({ text: 'window' }) }
    );

    pipeline.configureSession(fast.id, 'fast');
    pipeline.ingest({
      sessionId: fast.id,
      pcm: new Uint8Array(256_000),
      sampleRate: 16_000,
      channels: 1
    });
    await pipeline.finish(fast.id);
    service.stopCapture(fast.id);

    const quality = service.startCapture({ kind: 'chrome-tab', label: 'Quality tab' });
    pipeline.configureSession(quality.id, 'quality');
    pipeline.ingest({
      sessionId: quality.id,
      pcm: new Uint8Array(256_000),
      sampleRate: 16_000,
      channels: 1
    });
    await pipeline.finish(quality.id);

    expect(service.getSession(fast.id)?.rawSegments).toEqual([
      { startMs: 0, endMs: 4_000, text: 'window' },
      { startMs: 4_000, endMs: 8_000, text: 'window' }
    ]);
    expect(service.getSession(quality.id)?.rawSegments).toEqual([
      { startMs: 0, endMs: 8_000, text: 'window' }
    ]);
  });

  it('publishes two incremental windows before capture completion', async () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'chrome-tab', label: 'Current tab' });
    const pipeline = new BufferedAsrPipeline(
      service,
      { transcribe: async () => ({ text: 'increment' }) }
    );
    pipeline.configureSession(session.id, 'fast');
    pipeline.ingest({
      sessionId: session.id,
      pcm: new Uint8Array(256_000),
      sampleRate: 16_000,
      channels: 1
    });

    await pipeline.finish(session.id);

    expect(service.changesSince(session.id, 0)).toMatchObject({
      revision: 2,
      status: 'capturing',
      appendedSegments: [{ text: 'increment' }, { text: 'increment' }]
    });
    service.stopCapture(session.id);
    expect(service.changesSince(session.id, 2)).toMatchObject({
      revision: 3,
      status: 'complete',
      appendedSegments: []
    });
  });
});
