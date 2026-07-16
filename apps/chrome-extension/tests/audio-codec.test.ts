import { describe, expect, it } from 'vitest';

import { StreamingDownsampler } from '../src/audio-codec.js';

describe('StreamingDownsampler', () => {
  it('preserves 16 kHz duration across small 48 kHz worklet blocks', () => {
    const resampler = new StreamingDownsampler();
    const chunks = [new Float32Array(128), new Float32Array(128), new Float32Array(128)];

    const total = chunks.reduce((sum, chunk) => sum + resampler.resample(chunk, 48_000).length, 0);

    expect(total).toBe(128);
  });
});
