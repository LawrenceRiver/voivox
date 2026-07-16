import type { AsrWorkerRequest, AsrWorkerResponse } from './asr-worker-runtime.js';
import type { BrowserTranscriberState } from './browser-transcriber.js';
import type { TranscriptionMode } from './local-transcription.js';

export type AsrWorkerLike = {
  addEventListener(type: string, listener: EventListener): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
};

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: string | undefined) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

const WORKER_DISPOSE_TIMEOUT_MS = 1_000;
const MINIMUM_TRANSCRIPTION_WATCHDOG_MS = 30 * 60 * 1_000;

export type AsrWorkerOperationCode = 'cancelled' | 'timeout';

export class AsrWorkerOperationError extends Error {
  constructor(
    readonly code: AsrWorkerOperationCode,
    message = code === 'cancelled'
      ? 'Browser-local transcription was cancelled.'
      : 'Browser-local transcription timed out.'
  ) {
    super(message);
    this.name = 'AsrWorkerOperationError';
  }
}

export type AsrWorkerClientOptions = {
  transcriptionWatchdogMs?: (sampleCount: number, mode: TranscriptionMode) => number;
};

export function transcriptionWatchdogMs(
  sampleCount: number,
  mode: TranscriptionMode
): number {
  const audioDurationMs = Math.max(0, sampleCount) / 16_000 * 1_000;
  const realtimeFactor = mode === 'quality' ? 8 : 5;
  return MINIMUM_TRANSCRIPTION_WATCHDOG_MS + audioDurationMs * realtimeFactor;
}

export class AsrWorkerClient {
  private counter = 0;
  private closed = false;
  private disposePromise?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly worker: AsrWorkerLike,
    private readonly onStateChange: (state: BrowserTranscriberState) => void = () => undefined,
    private readonly onFatalError: (error: Error) => void = () => undefined,
    private readonly options: AsrWorkerClientOptions = {}
  ) {
    worker.addEventListener('message', (event) => this.handleMessage((event as MessageEvent).data));
    worker.addEventListener('error', () => this.failWorker(new Error('Browser-local model worker crashed.')));
    worker.addEventListener('messageerror', () => this.failWorker(new Error('Browser-local model worker returned an invalid message.')));
  }

  transcribe(audio: Float32Array, mode: TranscriptionMode): Promise<string> {
    const watchdogMs = (this.options.transcriptionWatchdogMs ?? transcriptionWatchdogMs)(
      audio.length,
      mode
    );
    const transferable = audio.buffer instanceof ArrayBuffer
      && audio.byteOffset === 0
      && audio.byteLength === audio.buffer.byteLength
      ? audio.buffer
      : audio.slice().buffer;
    return this.request({
      audio: transferable,
      mode,
      requestId: this.nextRequestId(),
      type: 'transcribe'
    }, [transferable], watchdogMs) as Promise<string>;
  }

  retry(): Promise<string> {
    return this.request({ requestId: this.nextRequestId(), type: 'retry' }) as Promise<string>;
  }

  cancel(): void {
    this.failWorker(new AsrWorkerOperationError('cancelled'));
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, WORKER_DISPOSE_TIMEOUT_MS);
      });
      const acknowledged = this.request({
        requestId: this.nextRequestId(),
        type: 'dispose'
      }).then(() => undefined);
      this.disposePromise = Promise.race([acknowledged, timedOut]).finally(() => {
        if (timeout) {
          clearTimeout(timeout);
        }
        this.closed = true;
        this.worker.terminate();
        for (const pending of this.pending.values()) {
          if (pending.timeout) {
            clearTimeout(pending.timeout);
          }
          pending.reject(new Error('Browser-local transcription worker was closed.'));
        }
        this.pending.clear();
      });
    }
    return this.disposePromise;
  }

  private nextRequestId(): string {
    this.counter += 1;
    return `asr_${this.counter}`;
  }

  private request(
    request: AsrWorkerRequest,
    transfer?: Transferable[],
    watchdogMs?: number
  ): Promise<string | undefined> {
    if (this.closed) {
      return Promise.reject(new Error('Browser-local transcription worker is closed.'));
    }
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { reject, resolve };
      this.pending.set(request.requestId, pending);
      if (watchdogMs !== undefined && Number.isFinite(watchdogMs) && watchdogMs > 0) {
        pending.timeout = setTimeout(() => {
          if (!this.pending.has(request.requestId)) {
            return;
          }
          this.failWorker(new AsrWorkerOperationError(
            'timeout',
            'Browser-local transcription timed out. The captured audio is still available for retry.'
          ));
        }, watchdogMs);
      }
      try {
        this.worker.postMessage(request, transfer);
      } catch (error) {
        this.pending.delete(request.requestId);
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        reject(error instanceof Error ? error : new Error('Could not contact the ASR worker.'));
      }
    });
  }

  private failWorker(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
    }
    this.pending.clear();
    this.worker.terminate();
    try {
      this.onFatalError(error);
    } catch {
      // Fatal observers are diagnostic only.
    }
  }

  private handleMessage(message: unknown): void {
    if (isStateMessage(message)) {
      try {
        this.onStateChange(message.state);
      } catch {
        // UI observers must not break the worker request channel.
      }
      return;
    }
    if (!isResponse(message)) {
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(message.requestId);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (message.type === 'error') {
      pending.reject(new Error(message.message));
      return;
    }
    pending.resolve(message.type === 'result' ? message.text : undefined);
  }
}

function isResponse(value: unknown): value is AsrWorkerResponse {
  if (
    typeof value !== 'object'
    || value === null
    || !('type' in value)
    || !('requestId' in value)
    || typeof value.requestId !== 'string'
  ) {
    return false;
  }
  return (value.type === 'result' && 'text' in value && typeof value.text === 'string')
    || value.type === 'disposed'
    || (value.type === 'error' && 'message' in value && typeof value.message === 'string');
}

function isStateMessage(value: unknown): value is { state: BrowserTranscriberState; type: 'state' } {
  return typeof value === 'object'
    && value !== null
    && 'type' in value
    && value.type === 'state'
    && 'state' in value
    && typeof value.state === 'object'
    && value.state !== null
    && 'phase' in value.state
    && typeof value.state.phase === 'string';
}
