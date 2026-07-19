import {
  VoiceVacError,
  VoivoxService,
  isVoiceVacError
} from '@voivox/core';

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
  closing: boolean;
  finishPromise?: Promise<void>;
  minimumWindowBytes: number;
  nextStartMs: number;
  work: Promise<void>;
};

export type AsrWindowMode = 'fast' | 'quality';

export class BufferedAsrPipeline {
  private readonly bufferedSessions = new Map<string, BufferedSession>();
  private readonly finishedSessionIds = new Set<string>();
  private readonly configuredWindowBytes = new Map<string, number>();
  private defaultWindowBytes: number;

  constructor(
    private readonly service: VoivoxService,
    private readonly engine: LocalAsrEngine,
    options: { minimumWindowMs?: number; onError?: (error: Error) => void } = {}
  ) {
    const defaultWindowMs = options.minimumWindowMs ?? 8_000;
    assertWindowDuration(defaultWindowMs);
    this.defaultWindowBytes = bytesForWindow(defaultWindowMs);
    this.onError = options.onError;
  }

  private readonly onError: ((error: Error) => void) | undefined;

  setMinimumWindowMs(minimumWindowMs: number): void {
    if (minimumWindowMs !== 4_000 && minimumWindowMs !== 8_000) {
      throw new Error('Production local ASR windows must be four or eight seconds.');
    }
    this.defaultWindowBytes = bytesForWindow(minimumWindowMs);
  }

  configureSession(sessionId: string, mode: AsrWindowMode): void {
    if (this.finishedSessionIds.has(sessionId) || this.bufferedSessions.get(sessionId)?.closing) {
      throw new Error('The local ASR session is finishing and no longer accepts configuration.');
    }
    if (this.bufferedSessions.has(sessionId)) {
      throw new Error('The local ASR window cannot change after audio ingestion begins.');
    }
    this.configuredWindowBytes.set(sessionId, bytesForWindow(mode === 'fast' ? 4_000 : 8_000));
  }

  ingest(chunk: BufferedAudioChunk): void {
    if (this.finishedSessionIds.has(chunk.sessionId)) {
      throw new Error('The local ASR session is finishing and no longer accepts audio.');
    }
    const currentState = this.bufferedSessions.get(chunk.sessionId);
    if (currentState?.closing) {
      throw new Error('The local ASR session is finishing and no longer accepts audio.');
    }
    const state = currentState ?? {
      audio: new Uint8Array(),
      closing: false,
      minimumWindowBytes: this.configuredWindowBytes.get(chunk.sessionId) ?? this.defaultWindowBytes,
      nextStartMs: 0,
      work: Promise.resolve()
    };
    state.audio = concatenate(state.audio, chunk.pcm);
    this.bufferedSessions.set(chunk.sessionId, state);

    while (state.audio.byteLength >= state.minimumWindowBytes) {
      this.scheduleWindow(chunk.sessionId, state, state.audio.slice(0, state.minimumWindowBytes));
      state.audio = state.audio.slice(state.minimumWindowBytes);
    }
  }

  finish(sessionId: string): Promise<void> {
    const state = this.bufferedSessions.get(sessionId);
    if (!state) {
      this.configuredWindowBytes.delete(sessionId);
      this.finishedSessionIds.add(sessionId);
      return Promise.resolve();
    }
    if (state.finishPromise) {
      return state.finishPromise;
    }

    state.closing = true;
    if (state.audio.byteLength > 0) {
      this.scheduleWindow(sessionId, state, state.audio);
      state.audio = new Uint8Array();
    }

    state.finishPromise = state.work.finally(() => {
      if (this.bufferedSessions.get(sessionId) === state) {
        this.bufferedSessions.delete(sessionId);
      }
      this.configuredWindowBytes.delete(sessionId);
      this.finishedSessionIds.add(sessionId);
    });
    return state.finishPromise;
  }

  private scheduleWindow(sessionId: string, state: BufferedSession, pcm: Uint8Array): void {
    const startMs = state.nextStartMs;
    const endMs = startMs + Math.round((pcm.byteLength / (16_000 * 2)) * 1_000);
    state.nextStartMs = endMs;
    state.work = state.work
      .then(async () => {
        try {
          const result = await this.engine.transcribe({ pcm, sampleRate: 16_000, channels: 1 });
          if (result.text.trim()) {
            this.service.appendRawSegment(sessionId, { startMs, endMs, text: result.text.trim() });
          }
        } catch (error: unknown) {
          const failure = normalizeAsrError(error);
          this.service.failCapture(sessionId, {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable
          });
          this.onError?.(failure);
          throw failure;
        }
      });
    void state.work.catch(() => undefined);
  }
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function bytesForWindow(windowMs: number): number {
  return Math.max(1, Math.floor((windowMs / 1_000) * 16_000 * 2));
}

function assertWindowDuration(windowMs: number): void {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('The local ASR window must be a positive duration.');
  }
}

function normalizeAsrError(error: unknown): VoiceVacError {
  if (isVoiceVacError(error)) {
    return error;
  }
  return new VoiceVacError('ASR_INFERENCE_FAILED', undefined, undefined, undefined, error);
}
