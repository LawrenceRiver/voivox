import { createTranscriptResult, type TranscriptResult } from '@voivox/core';

import type { LocalAsrEngine } from './asr-pipeline.js';

export type AcceleratedAudioChunk = {
  startMs: number;
  endMs: number;
  pcm: Uint8Array;
};

export class AcceleratedTranscriber {
  constructor(private readonly engine: LocalAsrEngine) {}

  async transcribeChunks(
    chunks: AcceleratedAudioChunk[],
    options: { title: string; language: string; sourceUrl?: string }
  ): Promise<TranscriptResult> {
    const results = await Promise.all(
      chunks
        .filter((chunk) => chunk.pcm.byteLength > 0 && chunk.endMs > chunk.startMs)
        .map(async (chunk) => ({
          chunk,
          result: await this.engine.transcribe({ pcm: chunk.pcm, sampleRate: 16_000, channels: 1 })
        }))
    );
    const ordered = results
      .sort((left, right) => left.chunk.startMs - right.chunk.startMs)
      .map(({ chunk, result }) => ({
        start: chunk.startMs / 1_000,
        end: chunk.endMs / 1_000,
        text: result.text.trim()
      }))
      .filter((segment) => segment.text.length > 0)
      .filter((segment, index, all) => index === 0 || segment.text !== all[index - 1]!.text)
      .reduce<Array<{ start: number; end: number; text: string }>>((merged, segment) => {
        const previousEnd = merged.at(-1)?.end ?? 0;
        const start = Math.max(segment.start, previousEnd);
        if (segment.end > start) {
          merged.push({ ...segment, start });
        }
        return merged;
      }, []);

    return createTranscriptResult({
      ...(options.sourceUrl ? { source_url: options.sourceUrl } : {}),
      title: options.title,
      language: options.language,
      duration_seconds: Math.max(...ordered.map((segment) => segment.end), 0),
      processing_mode: 'accelerated_batch',
      transcript: ordered.map((segment) => segment.text).join(' '),
      segments: ordered
    });
  }
}
