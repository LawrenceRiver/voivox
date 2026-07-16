export type CapturedAudioOptions = {
  maximumSeconds: number;
  sampleRate: number;
};

export class CapturedAudio {
  private readonly chunks: Float32Array[] = [];
  private readonly maximumSamples: number;
  private sampleCount = 0;

  readonly sampleRate: number;

  constructor({ maximumSeconds, sampleRate }: CapturedAudioOptions) {
    if (!Number.isFinite(maximumSeconds) || maximumSeconds <= 0) {
      throw new Error('Maximum capture duration must be positive.');
    }
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new Error('Capture sample rate must be a positive integer.');
    }

    this.sampleRate = sampleRate;
    this.maximumSamples = Math.floor(maximumSeconds * sampleRate);
  }

  get durationSeconds(): number {
    return this.sampleCount / this.sampleRate;
  }

  append(samples: Float32Array): boolean {
    const available = this.maximumSamples - this.sampleCount;
    if (available <= 0) {
      return samples.length === 0;
    }

    const acceptedCount = Math.min(available, samples.length);
    if (acceptedCount > 0) {
      this.chunks.push(samples.slice(0, acceptedCount));
      this.sampleCount += acceptedCount;
    }
    return acceptedCount === samples.length;
  }

  snapshot(): Float32Array {
    const result = new Float32Array(this.sampleCount);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  isSilent(rmsThreshold = 0.001): boolean {
    if (this.sampleCount === 0) {
      return true;
    }

    let energy = 0;
    for (const chunk of this.chunks) {
      for (const sample of chunk) {
        energy += sample * sample;
      }
    }
    return Math.sqrt(energy / this.sampleCount) < rmsThreshold;
  }

  clear(): void {
    this.chunks.length = 0;
    this.sampleCount = 0;
  }
}
