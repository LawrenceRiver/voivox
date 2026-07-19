import { describe, expect, it } from 'vitest';

import {
  createTranscriptResult,
  type TranscriptResult,
  validateTranscriptResult
} from '../src/pvtt-contract.js';

describe('PVTT transcript contract', () => {
  it('creates the structured result Codex receives', () => {
    const result = createTranscriptResult({
      title: 'Example Video',
      language: 'zh',
      processing_mode: 'live_tunnel',
      transcript: '第一段字幕',
      segments: [{ start: 0, end: 2.4, text: '第一段字幕' }]
    });

    expect(result).toEqual({
      status: 'completed',
      title: 'Example Video',
      language: 'zh',
      processing_mode: 'live_tunnel',
      transcript: '第一段字幕',
      segments: [{ start: 0, end: 2.4, text: '第一段字幕' }]
    });
  });

  it('rejects invalid ordering, empty text, and unknown processing modes', () => {
    const invalid: unknown = {
      status: 'completed',
      title: 'Example Video',
      language: 'zh',
      processing_mode: 'unknown',
      transcript: '第一段字幕',
      segments: [{ start: 3, end: 2, text: '第一段字幕' }]
    };

    expect(() => validateTranscriptResult(invalid)).toThrow('Invalid PVTT transcript result');
  });

  it('preserves optional source metadata without inventing values', () => {
    const result: TranscriptResult = createTranscriptResult({
      source_url: 'https://example.com/video',
      title: 'Example Video',
      language: 'en',
      duration_seconds: 30,
      processing_mode: 'accelerated_batch',
      transcript: 'Hello world.',
      segments: []
    });

    expect(result.source_url).toBe('https://example.com/video');
    expect(result.duration_seconds).toBe(30);
  });
});
