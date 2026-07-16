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

    const windowSamples = Math.max(1, Math.round(this.sampleRate * 0.1));
    const hopSamples = Math.max(1, Math.floor(windowSamples / 2));
    const peakThreshold = Math.max(0.01, rmsThreshold * 8);
    const squaredWindow = new Float64Array(windowSamples);
    let windowEnergy = 0;
    let windowCount = 0;
    let ringIndex = 0;
    let samplesSinceCheck = 0;
    for (const chunk of this.chunks) {
      for (const sample of chunk) {
        if (Math.abs(sample) >= peakThreshold) {
          return false;
        }
        const squared = sample * sample;
        if (windowCount < windowSamples) {
          squaredWindow[windowCount] = squared;
          windowEnergy += squared;
          windowCount += 1;
          if (windowCount === windowSamples) {
            if (Math.sqrt(windowEnergy / windowSamples) >= rmsThreshold) {
              return false;
            }
            samplesSinceCheck = 0;
          }
          continue;
        }

        windowEnergy += squared - squaredWindow[ringIndex]!;
        squaredWindow[ringIndex] = squared;
        ringIndex = (ringIndex + 1) % windowSamples;
        samplesSinceCheck += 1;
        if (samplesSinceCheck === hopSamples) {
          if (Math.sqrt(Math.max(0, windowEnergy) / windowSamples) >= rmsThreshold) {
            return false;
          }
          samplesSinceCheck = 0;
        }
      }
    }
    const denominator = windowCount < windowSamples ? windowCount : windowSamples;
    return denominator === 0
      || Math.sqrt(Math.max(0, windowEnergy) / denominator) < rmsThreshold;
  }

  clear(): void {
    this.chunks.length = 0;
    this.sampleCount = 0;
  }
}
