import { describe, expect, it, vi } from 'vitest';

import { AcceleratedTranscriber } from '../src/main/accelerated-transcriber.js';
import { chunkPcm16le } from '../src/main/ffmpeg-audio-decoder.js';

describe('AcceleratedTranscriber', () => {
  it('runs chunks concurrently and merges them in source order', async () => {
    const engine = {
      transcribe: vi.fn()
        .mockResolvedValueOnce({ text: '第二段' })
        .mockResolvedValueOnce({ text: '第一段' })
    };
    const transcriber = new AcceleratedTranscriber(engine);

    const result = await transcriber.transcribeChunks([
      { startMs: 1_000, endMs: 2_000, pcm: new Uint8Array([2]) },
      { startMs: 0, endMs: 1_000, pcm: new Uint8Array([1]) }
    ], { title: '视频', language: 'zh' });

    expect(engine.transcribe).toHaveBeenCalledTimes(2);
    expect(result.processing_mode).toBe('accelerated_batch');
    expect(result.transcript).toBe('第一段 第二段');
    expect(result.segments).toEqual([
      { start: 0, end: 1, text: '第一段' },
      { start: 1, end: 2, text: '第二段' }
    ]);
  });

  it('drops empty chunks and duplicate overlap text', async () => {
    const transcriber = new AcceleratedTranscriber({
      transcribe: vi.fn()
        .mockResolvedValueOnce({ text: '重复内容' })
        .mockResolvedValueOnce({ text: '重复内容' })
    });

    const result = await transcriber.transcribeChunks([
      { startMs: 0, endMs: 1_000, pcm: new Uint8Array([1]) },
      { startMs: 900, endMs: 1_900, pcm: new Uint8Array([2]) },
      { startMs: 2_000, endMs: 2_100, pcm: new Uint8Array() }
    ], { title: '视频', language: 'zh' });

    expect(result.segments).toEqual([{ start: 0, end: 1, text: '重复内容' }]);
  });

  it('clips non-duplicate overlap before validating PVTT segments', async () => {
    const transcriber = new AcceleratedTranscriber({
      transcribe: vi.fn()
        .mockResolvedValueOnce({ text: '第一段' })
        .mockResolvedValueOnce({ text: '第二段' })
    });

    const result = await transcriber.transcribeChunks([
      { startMs: 0, endMs: 1_000, pcm: new Uint8Array([1]) },
      { startMs: 900, endMs: 1_900, pcm: new Uint8Array([2]) }
    ], { title: '视频', language: 'zh' });

    expect(result.segments).toEqual([
      { start: 0, end: 1, text: '第一段' },
      { start: 1, end: 1.9, text: '第二段' }
    ]);
  });

  it('creates ordered 16 kHz mono chunks with bounded overlap', () => {
    const pcm = new Uint8Array(16_000 * 2 * 3);
    const chunks = chunkPcm16le(pcm, { chunkSeconds: 2, overlapSeconds: 0.5 });
    expect(chunks.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
      [0, 2_000],
      [1_500, 3_000]
    ]);
    expect(chunks.every((chunk) => chunk.pcm.byteLength % 2 === 0)).toBe(true);
  });
});
