import { describe, expect, it } from 'vitest';

import { VoivoxService } from '@voivox/core';
import { BufferedAsrPipeline } from '../src/main/asr-pipeline.js';

describe('BufferedAsrPipeline', () => {
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

  it('reports an unavailable local model without leaving the capture unable to stop', async () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'chrome-tab', label: 'Current tab' });
    const errors: string[] = [];
    const pipeline = new BufferedAsrPipeline(
      service,
      { transcribe: async () => Promise.reject(new Error('Local model is not installed.')) },
      { minimumWindowMs: 1_000, onError: (error) => errors.push(error.message) }
    );

    pipeline.ingest({
      sessionId: session.id,
      pcm: new Uint8Array(32_000),
      sampleRate: 16_000,
      channels: 1
    });

    await expect(pipeline.finish(session.id)).resolves.toBeUndefined();
    expect(errors).toEqual(['Local model is not installed.']);
  });

  it('uses a shorter runtime-selected window for fast collection', async () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'chrome-tab', label: 'Current tab' });
    const pipeline = new BufferedAsrPipeline(service, { transcribe: async () => ({ text: '快速分段。' }) });

    pipeline.setMinimumWindowMs(500);
    pipeline.ingest({
      sessionId: session.id,
      pcm: new Uint8Array(16_000),
      sampleRate: 16_000,
      channels: 1
    });
    await pipeline.finish(session.id);

    expect(service.getSession(session.id)?.rawSegments).toEqual([
      { startMs: 0, endMs: 500, text: '快速分段。' }
    ]);
  });
});
