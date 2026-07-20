const TARGET_SAMPLE_RATE = 16_000;
const PCM16_BYTES_PER_SAMPLE = 2;
const ONE_SECOND_PCM16_BYTES = TARGET_SAMPLE_RATE * PCM16_BYTES_PER_SAMPLE;

export function float32ToPcm16LittleEndian(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * PCM16_BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const pcm = clipped < 0
      ? Math.round(clipped * 32_768)
      : Math.round(clipped * 32_767);
    view.setInt16(index * PCM16_BYTES_PER_SAMPLE, pcm, true);
  }
  return bytes;
}

export class Pcm16SecondChunker {
  private buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();

  append(samples: Float32Array): Uint8Array[] {
    if (samples.length === 0) return [];
    this.buffered = concatenateBytes(this.buffered, float32ToPcm16LittleEndian(samples));
    const chunks: Uint8Array[] = [];
    while (this.buffered.byteLength >= ONE_SECOND_PCM16_BYTES) {
      chunks.push(this.buffered.slice(0, ONE_SECOND_PCM16_BYTES));
      this.buffered = this.buffered.slice(ONE_SECOND_PCM16_BYTES);
    }
    return chunks;
  }

  flush(): Uint8Array | undefined {
    if (this.buffered.byteLength === 0) return undefined;
    const final = this.buffered.slice();
    this.buffered = new Uint8Array();
    return final;
  }

  reset(): void {
    this.buffered = new Uint8Array();
  }
}

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

function concatenateBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}
