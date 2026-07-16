const TARGET_SAMPLE_RATE = 16_000;

export class StreamingDownsampler {
  private buffer: Float32Array<ArrayBufferLike> = new Float32Array();
  private bufferStart = 0;
  private nextPosition = 0;
  private sourceRate: number | undefined;

  reset(): void {
    this.buffer = new Float32Array();
    this.bufferStart = 0;
    this.nextPosition = 0;
    this.sourceRate = undefined;
  }

  resample(samples: Float32Array, sourceRate: number): Float32Array {
    if (sourceRate === TARGET_SAMPLE_RATE) {
      return samples.slice();
    }
    if (this.sourceRate !== sourceRate) {
      this.reset();
      this.sourceRate = sourceRate;
    }

    this.buffer = concatenate(this.buffer, samples);
    const output: number[] = [];
    const inputEnd = this.bufferStart + this.buffer.length;
    const step = sourceRate / TARGET_SAMPLE_RATE;

    while (this.nextPosition + 1 < inputEnd) {
      const relativePosition = this.nextPosition - this.bufferStart;
      const lower = Math.floor(relativePosition);
      const fraction = relativePosition - lower;
      const left = this.buffer[lower] ?? 0;
      const right = this.buffer[lower + 1] ?? left;
      output.push(left + (right - left) * fraction);
      this.nextPosition += step;
    }

    const keepFrom = Math.max(0, Math.floor(this.nextPosition - this.bufferStart) - 1);
    this.buffer = this.buffer.slice(keepFrom);
    this.bufferStart += keepFrom;
    return new Float32Array(output);
  }
}

function concatenate(
  left: Float32Array<ArrayBufferLike>,
  right: Float32Array<ArrayBufferLike>
): Float32Array<ArrayBufferLike> {
  const result = new Float32Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}
