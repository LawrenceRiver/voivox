export class BoundedAudioQueue {
  private samples: number[] = [];

  constructor(private readonly maximumSamples: number) {
    if (!Number.isInteger(maximumSamples) || maximumSamples <= 0) {
      throw new Error('Audio queue capacity must be a positive integer.');
    }
  }

  get size(): number {
    return this.samples.length;
  }

  append(samples: Float32Array): boolean {
    const available = this.maximumSamples - this.samples.length;
    if (available <= 0) {
      return false;
    }

    const accepted = samples.subarray(0, available);
    this.samples.push(...accepted);
    return accepted.length === samples.length;
  }

  take(): { count: number; samples: Float32Array } {
    return { count: this.samples.length, samples: new Float32Array(this.samples) };
  }

  acknowledge(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > this.samples.length) {
      throw new Error('Cannot acknowledge audio that is not queued.');
    }
    this.samples.splice(0, count);
  }

  clear(): void {
    this.samples = [];
  }
}
