import { Pcm16SecondChunker } from './audio-codec.js';
import type { BridgeConfig } from './bridge.js';
import type { TranscriptionMode } from './local-transcription.js';

const MAXIMUM_PENDING_CHUNKS = 5;
const MAXIMUM_LONG_POLL_WAIT_MS = 25_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINAL_WAIT_MS = 2 * 60_000;

export const DESKTOP_RELAY_ERROR_CODES = Object.freeze([
  'NEEDS_USER_ARMING',
  'TAB_NOT_ARMED',
  'TARGET_NAVIGATED',
  'TAB_CLOSED',
  'CAPTURE_DENIED',
  'STREAM_ID_EXPIRED',
  'STREAM_ENDED',
  'NATIVE_HOST_UNAVAILABLE',
  'EXTENSION_UNAVAILABLE',
  'COMMAND_ACK_TIMEOUT',
  'ASR_RUNTIME_MISSING',
  'ASR_MODEL_MISSING',
  'ASR_MODEL_LOAD_FAILED',
  'ASR_STARTUP_TIMEOUT',
  'ASR_INFERENCE_TIMEOUT',
  'ASR_INFERENCE_FAILED',
  'AUDIO_SEQUENCE_MISMATCH',
  'AUDIO_RELAY_BACKPRESSURE',
  'NO_AUDIO_AFTER_TIMEOUT',
  'TRANSCRIPTION_CANCELLED',
  'TRANSCRIPTION_DEADLINE_EXCEEDED',
  'ACCELERATED_SOURCE_UNAVAILABLE'
] as const);

export type DesktopRelayErrorCode = typeof DESKTOP_RELAY_ERROR_CODES[number];
export type DesktopTranscriptStatus = 'capturing' | 'complete' | 'interrupted' | 'failed' | 'cancelled';

export type DesktopTranscriptSegment = Readonly<{
  startMs: number;
  endMs: number;
  text: string;
}>;

export type DesktopTranscriptFailure = Readonly<{
  code: DesktopRelayErrorCode;
  message: string;
  retryable: boolean;
}>;

export type DesktopTranscriptDelta = Readonly<{
  sessionId: string;
  afterRevision: number;
  revision: number;
  status: DesktopTranscriptStatus;
  appendedSegments: readonly DesktopTranscriptSegment[];
  failure?: DesktopTranscriptFailure;
}>;

export type DesktopTranscriptSnapshot = Readonly<{
  revision: number;
  segments: readonly DesktopTranscriptSegment[];
  sessionId: string;
  status: DesktopTranscriptStatus;
  transcript: string;
}>;

export type DesktopAudioRelayStart = Readonly<{
  jobId?: string;
  language?: string;
  mode: TranscriptionMode;
  tabTitle: string;
  tabUrl: string;
  tunnelSessionId: string;
}>;

export class DesktopAudioRelayError extends Error {
  constructor(
    readonly code: DesktopRelayErrorCode,
    message = defaultErrorMessage(code),
    readonly retryable = defaultRetryable(code),
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'DesktopAudioRelayError';
  }
}

export class DesktopAudioRelay {
  private readonly baseUrl: string;
  private readonly bridge: BridgeConfig;
  private readonly chunker = new Pcm16SecondChunker();
  private readonly fetcher: typeof fetch;
  private readonly lifecycleAbort = new AbortController();
  private readonly longPollWaitMs: number;
  private readonly onDelta?: (snapshot: DesktopTranscriptSnapshot) => void | Promise<void>;
  private readonly onFailure?: (error: DesktopAudioRelayError) => void | Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly terminalWaitMs: number;
  private audioTail: Promise<void> = Promise.resolve();
  private failure?: DesktopAudioRelayError;
  private nextSequence = 0;
  private pendingChunks = 0;
  private pollPromise?: Promise<void>;
  private revision = 0;
  private segments: DesktopTranscriptSegment[] = [];
  private sessionId?: string;
  private status: DesktopTranscriptStatus = 'capturing';
  private stopPromise?: Promise<DesktopTranscriptSnapshot>;

  constructor(options: {
    bridge: BridgeConfig;
    fetcher?: typeof fetch;
    longPollWaitMs?: number;
    onDelta?: (snapshot: DesktopTranscriptSnapshot) => void | Promise<void>;
    onFailure?: (error: DesktopAudioRelayError) => void | Promise<void>;
    requestTimeoutMs?: number;
    terminalWaitMs?: number;
  }) {
    this.baseUrl = normalizeExactLoopbackBaseUrl(options.bridge.baseUrl);
    if (!options.bridge.token) {
      throw new DesktopAudioRelayError('NATIVE_HOST_UNAVAILABLE');
    }
    this.bridge = { baseUrl: this.baseUrl, token: options.bridge.token };
    this.fetcher = options.fetcher ?? fetch;
    this.longPollWaitMs = boundedInteger(
      options.longPollWaitMs ?? MAXIMUM_LONG_POLL_WAIT_MS,
      1,
      MAXIMUM_LONG_POLL_WAIT_MS,
      'long-poll wait'
    );
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      5 * 60_000,
      'request timeout'
    );
    this.terminalWaitMs = boundedInteger(
      options.terminalWaitMs ?? DEFAULT_TERMINAL_WAIT_MS,
      1,
      30 * 60_000,
      'terminal wait'
    );
    this.onDelta = options.onDelta;
    this.onFailure = options.onFailure;
  }

  async start(input: DesktopAudioRelayStart): Promise<string> {
    if (this.sessionId) throw new DesktopAudioRelayError('STREAM_ENDED');
    assertStartInput(input);
    const boundedTitle = input.tabTitle.trim().slice(0, 500);
    const response = await this.request('/v1/extension/captures', {
      body: JSON.stringify({
        ...(input.jobId ? { jobId: input.jobId } : {}),
        mode: input.mode,
        source: {
          kind: 'chrome-tab',
          label: boundedTitle,
          title: boundedTitle,
          url: input.tabUrl,
          ...(input.language ? { language: input.language } : {})
        },
        tunnelSessionId: input.tunnelSessionId
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    });
    const body = await readJsonObject(response);
    if (typeof body.id !== 'string' || !body.id) {
      throw new DesktopAudioRelayError('ASR_INFERENCE_FAILED');
    }
    this.sessionId = body.id;
    this.pollPromise = this.pollTranscript().catch((error: unknown) => {
      const failure = this.rememberFailure(toRelayError(error));
      throw failure;
    });
    void this.pollPromise.catch(() => undefined);
    return body.id;
  }

  append(samples: Float32Array): void {
    this.requireStarted();
    if (this.stopPromise || this.failure) throw this.failure ?? new DesktopAudioRelayError('STREAM_ENDED');
    const chunks = this.chunker.append(samples);
    if (this.pendingChunks + chunks.length > MAXIMUM_PENDING_CHUNKS) {
      throw this.rememberFailure(new DesktopAudioRelayError('AUDIO_RELAY_BACKPRESSURE'));
    }
    for (const chunk of chunks) this.enqueueChunk(chunk);
  }

  stop(): Promise<DesktopTranscriptSnapshot> {
    this.requireStarted();
    this.stopPromise ??= this.finish();
    return this.stopPromise;
  }

  cancel(): void {
    if (!this.lifecycleAbort.signal.aborted) this.lifecycleAbort.abort();
  }

  snapshot(): DesktopTranscriptSnapshot {
    return this.copySnapshot();
  }

  private async finish(): Promise<DesktopTranscriptSnapshot> {
    const final = this.chunker.flush();
    if (final) {
      // This tail was already accepted by append(). Stop closes the producer,
      // so queue it behind the five bounded live chunks instead of dropping it.
      this.enqueueChunk(final);
    }

    try {
      await this.audioTail;
    } catch (error) {
      this.rememberFailure(toRelayError(error));
    }

    try {
      await this.request(`/v1/extension/captures/${encodeURIComponent(this.requireStarted())}/stop`, {
        method: 'POST'
      }, this.terminalWaitMs, 'ASR_INFERENCE_TIMEOUT');
    } catch (error) {
      this.rememberFailure(toRelayError(error));
    }

    if (this.failure) return this.abortPollingAndThrow(this.failure);
    const polling = this.pollPromise;
    if (!polling) throw new DesktopAudioRelayError('STREAM_ENDED');
    try {
      await withDeadline(polling, this.terminalWaitMs, () => {
        const failure = this.rememberFailure(new DesktopAudioRelayError('ASR_INFERENCE_TIMEOUT'));
        this.cancel();
        return failure;
      });
    } catch (error) {
      return this.abortPollingAndThrow(this.rememberFailure(toRelayError(error)));
    }
    if (this.failure) return this.abortPollingAndThrow(this.failure);
    if (this.status !== 'complete') {
      return this.abortPollingAndThrow(this.rememberFailure(new DesktopAudioRelayError('STREAM_ENDED')));
    }
    return this.copySnapshot();
  }

  private async abortPollingAndThrow(failure: DesktopAudioRelayError): Promise<never> {
    this.cancel();
    await this.pollPromise?.catch(() => undefined);
    throw failure;
  }

  private enqueueChunk(chunk: Uint8Array): void {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.pendingChunks += 1;
    const send = this.audioTail.then(async () => {
      await this.request(
        `/v1/extension/captures/${encodeURIComponent(this.requireStarted())}/audio/${sequence}`,
        {
          body: Uint8Array.from(chunk).buffer,
          headers: { 'content-type': 'application/octet-stream' },
          method: 'POST'
        }
      );
    });
    this.audioTail = send.finally(() => {
      this.pendingChunks -= 1;
    });
    void this.audioTail.catch((error: unknown) => {
      this.rememberFailure(toRelayError(error));
    });
  }

  private async pollTranscript(): Promise<void> {
    while (!isTerminalStatus(this.status)) {
      const response = await this.request(
        `/v1/extension/captures/${encodeURIComponent(this.requireStarted())}/transcript`
          + `?after_revision=${this.revision}&wait_ms=${this.longPollWaitMs}`,
        { method: 'GET' }
      );
      if (response.status === 204) {
        await yieldToEventLoop();
        continue;
      }
      const delta = parseTranscriptDelta(await readJsonObject(response), this.requireStarted(), this.revision);
      assertOrderedSegments(this.segments, delta.appendedSegments);
      this.revision = delta.revision;
      this.status = delta.status;
      this.segments.push(...delta.appendedSegments.map((segment) => ({ ...segment })));
      await this.onDelta?.(this.copySnapshot());
      if (delta.failure) {
        throw new DesktopAudioRelayError(
          delta.failure.code,
          delta.failure.message,
          delta.failure.retryable
        );
      }
      if (delta.status === 'cancelled') throw new DesktopAudioRelayError('TRANSCRIPTION_CANCELLED');
      if (delta.status === 'failed') throw new DesktopAudioRelayError('ASR_INFERENCE_FAILED');
      if (delta.status === 'interrupted') throw new DesktopAudioRelayError('STREAM_ENDED');
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs = this.requestTimeoutMs,
    timeoutCode: DesktopRelayErrorCode = 'NATIVE_HOST_UNAVAILABLE'
  ): Promise<Response> {
    if (this.lifecycleAbort.signal.aborted) {
      throw new DesktopAudioRelayError('TRANSCRIPTION_CANCELLED');
    }
    const controller = new AbortController();
    const onLifecycleAbort = () => controller.abort();
    this.lifecycleAbort.signal.addEventListener('abort', onLifecycleAbort, { once: true });
    let didTimeOut = false;
    const timeout = setTimeout(() => {
      didTimeOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        cache: 'no-store',
        credentials: 'omit',
        headers: {
          authorization: `Bearer ${this.bridge.token}`,
          ...init.headers
        },
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      if (!response.ok && response.status !== 204) throw await responseError(response);
      return response;
    } catch (error) {
      if (error instanceof DesktopAudioRelayError) throw error;
      if (this.lifecycleAbort.signal.aborted) {
        throw new DesktopAudioRelayError('TRANSCRIPTION_CANCELLED', undefined, undefined, { cause: error });
      }
      if (didTimeOut) {
        throw new DesktopAudioRelayError(timeoutCode, undefined, undefined, { cause: error });
      }
      throw new DesktopAudioRelayError('NATIVE_HOST_UNAVAILABLE', undefined, undefined, { cause: error });
    } finally {
      clearTimeout(timeout);
      this.lifecycleAbort.signal.removeEventListener('abort', onLifecycleAbort);
    }
  }

  private rememberFailure(error: DesktopAudioRelayError): DesktopAudioRelayError {
    if (!this.failure) {
      this.failure = error;
      void Promise.resolve(this.onFailure?.(error)).catch(() => undefined);
    }
    return this.failure;
  }

  private requireStarted(): string {
    if (!this.sessionId) throw new DesktopAudioRelayError('STREAM_ENDED');
    return this.sessionId;
  }

  private copySnapshot(): DesktopTranscriptSnapshot {
    return {
      revision: this.revision,
      segments: this.segments.map((segment) => ({ ...segment })),
      sessionId: this.sessionId ?? '',
      status: this.status,
      transcript: this.segments.map((segment) => segment.text.trim()).filter(Boolean).join('\n')
    };
  }
}

function assertStartInput(input: DesktopAudioRelayStart): void {
  if (
    (input.mode !== 'fast' && input.mode !== 'quality')
    || !input.tabTitle.trim()
    || !input.tunnelSessionId.trim()
    || !isCanonicalHttpUrl(input.tabUrl)
  ) {
    throw new DesktopAudioRelayError('TAB_NOT_ARMED');
  }
}

function parseTranscriptDelta(
  body: Record<string, unknown>,
  expectedSessionId: string,
  expectedRevision: number
): DesktopTranscriptDelta {
  if (
    body.sessionId !== expectedSessionId
    || body.afterRevision !== expectedRevision
    || !Number.isSafeInteger(body.revision)
    || (body.revision as number) <= expectedRevision
    || !isTranscriptStatus(body.status)
    || !Array.isArray(body.appendedSegments)
  ) {
    throw new DesktopAudioRelayError('ASR_INFERENCE_FAILED');
  }
  const segments = body.appendedSegments.map((value) => parseSegment(value));
  const failure = body.failure === undefined ? undefined : parseFailure(body.failure);
  return {
    afterRevision: expectedRevision,
    appendedSegments: segments,
    ...(failure ? { failure } : {}),
    revision: body.revision as number,
    sessionId: expectedSessionId,
    status: body.status
  };
}

function parseSegment(value: unknown): DesktopTranscriptSegment {
  if (
    !isRecord(value)
    || !Number.isFinite(value.startMs)
    || !Number.isFinite(value.endMs)
    || (value.startMs as number) < 0
    || (value.endMs as number) < (value.startMs as number)
    || typeof value.text !== 'string'
    || !value.text.trim()
  ) {
    throw new DesktopAudioRelayError('ASR_INFERENCE_FAILED');
  }
  return { endMs: value.endMs as number, startMs: value.startMs as number, text: value.text };
}

function assertOrderedSegments(
  existing: readonly DesktopTranscriptSegment[],
  appended: readonly DesktopTranscriptSegment[]
): void {
  let previousEndMs = existing.at(-1)?.endMs ?? 0;
  for (const segment of appended) {
    if (segment.startMs < previousEndMs) {
      throw new DesktopAudioRelayError('ASR_INFERENCE_FAILED');
    }
    previousEndMs = segment.endMs;
  }
}

function parseFailure(value: unknown): DesktopTranscriptFailure {
  if (
    !isRecord(value)
    || !isDesktopRelayErrorCode(value.code)
    || typeof value.message !== 'string'
    || typeof value.retryable !== 'boolean'
  ) {
    throw new DesktopAudioRelayError('ASR_INFERENCE_FAILED');
  }
  return { code: value.code, message: value.message, retryable: value.retryable };
}

async function responseError(response: Response): Promise<DesktopAudioRelayError> {
  try {
    const body = await readJsonObject(response);
    if (
      isDesktopRelayErrorCode(body.code)
      && typeof body.error === 'string'
      && typeof body.retryable === 'boolean'
    ) {
      return new DesktopAudioRelayError(body.code, body.error, body.retryable);
    }
  } catch {
    // The authenticated bridge did not return its stable error contract.
  }
  return new DesktopAudioRelayError('NATIVE_HOST_UNAVAILABLE');
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json() as unknown;
  if (!isRecord(body)) throw new DesktopAudioRelayError('ASR_INFERENCE_FAILED');
  return body;
}

function normalizeExactLoopbackBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (
      url.protocol !== 'http:'
      || url.hostname !== '127.0.0.1'
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
    ) {
      throw new Error('invalid loopback URL');
    }
    return `http://127.0.0.1:${port}`;
  } catch (error) {
    throw new DesktopAudioRelayError('NATIVE_HOST_UNAVAILABLE', undefined, undefined, { cause: error });
  }
}

function isCanonicalHttpUrl(value: string): boolean {
  if (!value || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Voice VAC ${label} is out of range.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDesktopRelayErrorCode(value: unknown): value is DesktopRelayErrorCode {
  return typeof value === 'string' && (DESKTOP_RELAY_ERROR_CODES as readonly string[]).includes(value);
}

function isTranscriptStatus(value: unknown): value is DesktopTranscriptStatus {
  return value === 'capturing'
    || value === 'complete'
    || value === 'interrupted'
    || value === 'failed'
    || value === 'cancelled';
}

function isTerminalStatus(status: DesktopTranscriptStatus): boolean {
  return status !== 'capturing';
}

function toRelayError(error: unknown): DesktopAudioRelayError {
  return error instanceof DesktopAudioRelayError
    ? error
    : new DesktopAudioRelayError('NATIVE_HOST_UNAVAILABLE', undefined, undefined, { cause: error });
}

function defaultRetryable(code: DesktopRelayErrorCode): boolean {
  return code !== 'ASR_RUNTIME_MISSING'
    && code !== 'ASR_MODEL_MISSING'
    && code !== 'ASR_MODEL_LOAD_FAILED'
    && code !== 'TRANSCRIPTION_CANCELLED'
    && code !== 'ACCELERATED_SOURCE_UNAVAILABLE';
}

function defaultErrorMessage(code: DesktopRelayErrorCode): string {
  const messages: Record<DesktopRelayErrorCode, string> = {
    ACCELERATED_SOURCE_UNAVAILABLE: 'Accelerated mode is unavailable for this media source.',
    ASR_INFERENCE_FAILED: 'Local speech recognition failed.',
    ASR_INFERENCE_TIMEOUT: 'Local speech recognition did not finish in time.',
    ASR_MODEL_LOAD_FAILED: 'Voice VAC could not load the local Qwen3-ASR model.',
    ASR_MODEL_MISSING: 'The local Qwen3-ASR model is not installed.',
    ASR_RUNTIME_MISSING: 'The local Voice VAC speech runtime is not installed.',
    ASR_STARTUP_TIMEOUT: 'The local speech model did not become ready in time.',
    AUDIO_RELAY_BACKPRESSURE: 'The private audio relay could not keep up.',
    AUDIO_SEQUENCE_MISMATCH: 'The private audio stream arrived out of order.',
    CAPTURE_DENIED: 'Chrome did not grant access to the selected tab audio.',
    COMMAND_ACK_TIMEOUT: 'The Voice VAC extension did not acknowledge the command in time.',
    EXTENSION_UNAVAILABLE: 'The Voice VAC Chrome extension is unavailable.',
    NATIVE_HOST_UNAVAILABLE: 'The Voice VAC native bridge is unavailable.',
    NEEDS_USER_ARMING: 'Click Voice VAC on the target tab before starting transcription.',
    NO_AUDIO_AFTER_TIMEOUT: 'No audio arrived from the selected tab.',
    STREAM_ENDED: 'The selected tab audio stream ended.',
    STREAM_ID_EXPIRED: 'The selected tab audio authorization expired.',
    TAB_CLOSED: 'The armed Chrome tab was closed.',
    TAB_NOT_ARMED: 'The selected Chrome tab is not armed.',
    TARGET_NAVIGATED: 'The armed page navigated. Arm the current page again.',
    TRANSCRIPTION_CANCELLED: 'The transcription was cancelled.',
    TRANSCRIPTION_DEADLINE_EXCEEDED: 'The transcription exceeded its overall deadline.'
  };
  return messages[code];
}

async function withDeadline<T>(
  promise: Promise<T>,
  waitMs: number,
  onTimeout: () => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), waitMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
