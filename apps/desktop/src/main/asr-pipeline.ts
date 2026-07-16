import { VoivoxService } from '@voivox/core';

export type BufferedAudioChunk = {
  channels: 1;
  pcm: Uint8Array;
  sampleRate: 16_000;
  sessionId: string;
};

export type LocalAsrEngine = {
  transcribe(audio: {
    pcm: Uint8Array;
    sampleRate: 16_000;
    channels: 1;
  }): Promise<{ text: string }>;
};

type BufferedSession = {
  audio: Uint8Array;
  nextStartMs: number;
  work: Promise<void>;
};

export class BufferedAsrPipeline {
  private readonly bufferedSessions = new Map<string, BufferedSession>();
  private minimumWindowBytes: number;

  constructor(
    private readonly service: VoivoxService,
    private readonly engine: LocalAsrEngine,
    options: { minimumWindowMs?: number; onError?: (error: Error) => void } = {}
  ) {
    this.minimumWindowBytes = 1;
    this.setMinimumWindowMs(options.minimumWindowMs ?? 8_000);
    this.onError = options.onError;
  }

  private readonly onError: ((error: Error) => void) | undefined;

  setMinimumWindowMs(minimumWindowMs: number): void {
    if (!Number.isFinite(minimumWindowMs) || minimumWindowMs <= 0) {
      throw new Error('The local ASR window must be a positive duration.');
    }
    this.minimumWindowBytes = Math.max(1, Math.floor((minimumWindowMs / 1_000) * 16_000 * 2));
  }

  ingest(chunk: BufferedAudioChunk): void {
    const state = this.bufferedSessions.get(chunk.sessionId) ?? {
      audio: new Uint8Array(),
      nextStartMs: 0,
      work: Promise.resolve()
    };
    state.audio = concatenate(state.audio, chunk.pcm);
    this.bufferedSessions.set(chunk.sessionId, state);

    while (state.audio.byteLength >= this.minimumWindowBytes) {
      this.scheduleWindow(chunk.sessionId, state, state.audio.slice(0, this.minimumWindowBytes));
      state.audio = state.audio.slice(this.minimumWindowBytes);
    }
  }

  async finish(sessionId: string): Promise<void> {
    const state = this.bufferedSessions.get(sessionId);
    if (!state) {
      return;
    }

    if (state.audio.byteLength > 0) {
      this.scheduleWindow(sessionId, state, state.audio);
      state.audio = new Uint8Array();
    }

    await state.work;
    this.bufferedSessions.delete(sessionId);
  }

  private scheduleWindow(sessionId: string, state: BufferedSession, pcm: Uint8Array): void {
    const startMs = state.nextStartMs;
    const endMs = startMs + Math.round((pcm.byteLength / (16_000 * 2)) * 1_000);
    state.nextStartMs = endMs;
    state.work = state.work
      .then(async () => {
        const result = await this.engine.transcribe({ pcm, sampleRate: 16_000, channels: 1 });
        if (result.text.trim()) {
          this.service.appendRawSegment(sessionId, { startMs, endMs, text: result.text.trim() });
        }
      })
      .catch((error: unknown) => {
        this.onError?.(error instanceof Error ? error : new Error('The local ASR engine failed.'));
      });
  }
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}
