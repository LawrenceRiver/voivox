import { describe, expect, it } from 'vitest';

import { CapturedAudio } from '../src/captured-audio.js';

describe('CapturedAudio', () => {
  it('retains at most the configured duration and reports truncation', () => {
    const audio = new CapturedAudio({ maximumSeconds: 1, sampleRate: 4 });

    expect(audio.append(new Float32Array([0.1, 0.2, 0.3]))).toBe(true);
    expect(audio.append(new Float32Array([0.4, 0.5]))).toBe(false);
    expect(audio.durationSeconds).toBe(1);
    expect(audio.snapshot()).toEqual(new Float32Array([0.1, 0.2, 0.3, 0.4]));
  });

  it('does not discard captured audio when a transcription attempt fails', async () => {
    const audio = new CapturedAudio({ maximumSeconds: 10, sampleRate: 4 });
    audio.append(new Float32Array([0.2, -0.2, 0.1]));

    await expect(Promise.reject(new Error('model interrupted'))).rejects.toThrow('model interrupted');

    expect(audio.snapshot()).toEqual(new Float32Array([0.2, -0.2, 0.1]));
  });

  it('distinguishes silence from audible samples using window and peak energy', () => {
    const silence = new CapturedAudio({ maximumSeconds: 10, sampleRate: 4 });
    silence.append(new Float32Array([0, 0.00001, -0.00001, 0]));
    expect(silence.isSilent()).toBe(true);

    const speech = new CapturedAudio({ maximumSeconds: 10, sampleRate: 4 });
    speech.append(new Float32Array([0, 0.04, -0.03, 0.02]));
    expect(speech.isSilent()).toBe(false);
  });

  it('does not let a long silent recording dilute a short audible passage', () => {
    const audio = new CapturedAudio({ maximumSeconds: 30, sampleRate: 1_000 });
    audio.append(new Float32Array(14_000));
    audio.append(new Float32Array(20).fill(0.02));
    audio.append(new Float32Array(14_000));

    expect(audio.isSilent()).toBe(false);
  });

  it('detects quiet speech that crosses a fixed window boundary', () => {
    const audio = new CapturedAudio({ maximumSeconds: 2, sampleRate: 1_000 });
    audio.append(new Float32Array(90));
    audio.append(new Float32Array(20).fill(0.003));
    audio.append(new Float32Array(890));

    expect(audio.isSilent()).toBe(false);
  });

  it('can be explicitly cleared after a successful save or cancellation', () => {
    const audio = new CapturedAudio({ maximumSeconds: 10, sampleRate: 4 });
    audio.append(new Float32Array([0.2, 0.1]));

    audio.clear();

    expect(audio.durationSeconds).toBe(0);
    expect(audio.snapshot()).toEqual(new Float32Array());
  });
});
