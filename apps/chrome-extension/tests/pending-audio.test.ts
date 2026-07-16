import { describe, expect, it } from 'vitest';

import { BoundedAudioQueue } from '../src/pending-audio.js';

describe('BoundedAudioQueue', () => {
  it('keeps unsent audio until the local bridge acknowledges it', () => {
    const queue = new BoundedAudioQueue(10);
    queue.append(new Float32Array([0.1, 0.2, 0.3]));

    const pending = queue.take();
    expect(pending.samples).toEqual(new Float32Array([0.1, 0.2, 0.3]));
    expect(queue.size).toBe(3);

    queue.acknowledge(pending.count);
    expect(queue.size).toBe(0);
  });

  it('keeps a finite buffer when the local bridge is unavailable', () => {
    const queue = new BoundedAudioQueue(4);

    expect(queue.append(new Float32Array([1, 2, 3]))).toBe(true);
    expect(queue.append(new Float32Array([4, 5]))).toBe(false);
    expect(queue.size).toBe(4);
    expect(queue.take().samples).toEqual(new Float32Array([1, 2, 3, 4]));
  });
});
