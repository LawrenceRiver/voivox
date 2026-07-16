declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}
declare function registerProcessor(name: string, constructor: typeof AudioWorkletProcessor): void;

class VoivoxCaptureProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0] ?? [];
    const firstChannel = channels[0];
    if (firstChannel) {
      const mono = new Float32Array(firstChannel.length);
      for (let sampleIndex = 0; sampleIndex < mono.length; sampleIndex += 1) {
        let total = 0;
        channels.forEach((channel) => {
          total += channel[sampleIndex] ?? 0;
        });
        mono[sampleIndex] = total / channels.length;
      }
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}

registerProcessor('voivox-capture', VoivoxCaptureProcessor);
