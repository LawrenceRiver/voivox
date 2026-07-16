import { describe, expect, it } from 'vitest';

import { durationFromWavHeader } from '../src/main/wav-duration.js';

describe('WAV duration parsing', () => {
  it('uses byte rate and data length to produce the transcript time range', () => {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(32_000, 28);
    header.write('data', 36);
    header.writeUInt32LE(64_000, 40);

    expect(durationFromWavHeader(header)).toBe(2_000);
  });
});
