import { describe, expect, it } from 'vitest';

import { StreamingDownsampler, float32ToPcm16 } from '../src/audio-codec.js';

describe('float32ToPcm16', () => {
  it('clamps browser audio and encodes signed 16-bit little-endian PCM', () => {
    expect([...float32ToPcm16(new Float32Array([-1.5, -1, 0, 1, 1.5]))]).toEqual([
      0,
      128,
      0,
      128,
      0,
      0,
      255,
      127,
      255,
      127
    ]);
  });
});

describe('StreamingDownsampler', () => {
  it('preserves 16 kHz duration across small 48 kHz worklet blocks', () => {
    const resampler = new StreamingDownsampler();
    const chunks = [new Float32Array(128), new Float32Array(128), new Float32Array(128)];

    const total = chunks.reduce((sum, chunk) => sum + resampler.resample(chunk, 48_000).length, 0);

    expect(total).toBe(128);
  });
});
