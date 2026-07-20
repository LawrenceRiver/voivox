import { describe, expect, it } from 'vitest';

import {
  Pcm16SecondChunker,
  StreamingDownsampler,
  float32ToPcm16LittleEndian
} from '../src/audio-codec.js';

describe('float32ToPcm16LittleEndian', () => {
  it('clips samples and writes signed PCM16 in little-endian order', () => {
    const pcm = float32ToPcm16LittleEndian(new Float32Array([
      -2,
      -1,
      -0.5,
      0,
      0.5,
      1,
      2
    ]));

    expect([...pcm]).toEqual([
      0x00, 0x80,
      0x00, 0x80,
      0x00, 0xc0,
      0x00, 0x00,
      0x00, 0x40,
      0xff, 0x7f,
      0xff, 0x7f
    ]);
  });
});

describe('Pcm16SecondChunker', () => {
  it('emits consecutive one-second 16 kHz mono chunks and flushes the final partial chunk', () => {
    const chunker = new Pcm16SecondChunker();
    const first = chunker.append(new Float32Array(10_000).fill(0.25));
    const second = chunker.append(new Float32Array(22_001).fill(-0.25));
    const final = chunker.flush();

    expect(first).toEqual([]);
    expect(second).toHaveLength(2);
    expect(second[0]).toHaveLength(32_000);
    expect(second[1]).toHaveLength(32_000);
    expect(final).toHaveLength(2);
    expect(chunker.flush()).toBeUndefined();
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
