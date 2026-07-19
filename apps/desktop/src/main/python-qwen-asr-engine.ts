import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  VOICE_VAC_ERROR_CODES,
  VoiceVacError,
  type VoiceVacErrorCode
} from '@voivox/core';

import type { LocalAsrEngine } from './asr-pipeline.js';

export type PythonQwenAsrStatus =
  | 'idle'
  | 'booting'
  | 'model_loading'
  | 'ready'
  | 'fatal'
  | 'closed';

type PendingRequest = {
  phase: 'awaiting_accept' | 'inference';
  reject: (error: Error) => void;
  resolve: (value: { text: string }) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

type WorkerTermination = {
  graceTimer: ReturnType<typeof setTimeout>;
  hardTimer: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
};

type StartDeferred = {
  reject: (error: Error) => void;
  resolve: () => void;
};

type WorkerFrame = Record<string, unknown> & { type?: unknown };

const DEFAULT_STARTUP_INACTIVITY_TIMEOUT_MS = 90_000;
const DEFAULT_STARTUP_HARD_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_ACCEPT_TIMEOUT_MS = 5_000;
const DEFAULT_INFERENCE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const ERROR_CODE_SET = new Set<string>(VOICE_VAC_ERROR_CODES);

export type PythonQwenAsrEngineOptions = {
  acceptTimeoutMs?: number;
  inferenceTimeoutMs?: number;
  /** @deprecated Use inferenceTimeoutMs. */
  requestTimeoutMs?: number;
  modelId?: string;
  modelPath?: string;
  pythonCommand: string;
  startupHardTimeoutMs?: number;
  startupInactivityTimeoutMs?: number;
  terminationGraceMs?: number;
  workerEnv?: NodeJS.ProcessEnv;
  workerPath: string;
};

export class PythonQwenAsrEngine implements LocalAsrEngine {
  private readonly acceptTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | undefined;
  private closed = false;
  private failure: VoiceVacError | undefined;
  private readonly inferenceTimeoutMs: number;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private serialTail: Promise<void> = Promise.resolve();
  private startDeferred: StartDeferred | undefined;
  private startupHardTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly startupHardTimeoutMs: number;
  private startupInactivityTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly startupInactivityTimeoutMs: number;
  private startPromise: Promise<void> | undefined;
  private status: PythonQwenAsrStatus = 'idle';
  private stderr = '';
  private readonly terminationGraceMs: number;
  private readonly terminations = new Map<ChildProcessWithoutNullStreams, WorkerTermination>();

  constructor(private readonly options: PythonQwenAsrEngineOptions) {
    this.acceptTimeoutMs = options.acceptTimeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS;
    this.inferenceTimeoutMs = options.inferenceTimeoutMs
      ?? options.requestTimeoutMs
      ?? DEFAULT_INFERENCE_TIMEOUT_MS;
    this.startupHardTimeoutMs = options.startupHardTimeoutMs ?? DEFAULT_STARTUP_HARD_TIMEOUT_MS;
    this.startupInactivityTimeoutMs = options.startupInactivityTimeoutMs
      ?? DEFAULT_STARTUP_INACTIVITY_TIMEOUT_MS;
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    [
      this.acceptTimeoutMs,
      this.inferenceTimeoutMs,
      this.startupHardTimeoutMs,
      this.startupInactivityTimeoutMs,
      this.terminationGraceMs
    ].forEach((timeout) => {
      if (!isPositiveTimeout(timeout)) {
        throw new Error('Voice VAC local ASR timeouts must be positive numbers.');
      }
    });
  }

  getStatus(): PythonQwenAsrStatus {
    return this.status;
  }

  start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.closed) {
      return Promise.reject(new VoiceVacError('TRANSCRIPTION_CANCELLED'));
    }

    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startDeferred = { resolve, reject };
      this.spawnWorker();
    });
    // The engine owns this promise even when callers defer observing it.
    void this.startPromise.catch(() => undefined);
    return this.startPromise;
  }

  transcribe(audio: {
    pcm: Uint8Array;
    sampleRate: 16_000;
    channels: 1;
  }): Promise<{ text: string }> {
    return this.enqueue({
      pcm: Buffer.from(audio.pcm).toString('base64'),
      sampleRate: audio.sampleRate,
      channels: audio.channels
    });
  }

  transcribeFile(audioPath: string): Promise<{ text: string }> {
    return this.enqueue({ audioPath });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.status = 'closed';
      this.clearStartupTimers();
      const cancelled = new VoiceVacError('TRANSCRIPTION_CANCELLED');
      this.startDeferred?.reject(cancelled);
      this.startDeferred = undefined;
      this.rejectAll(cancelled);
      const child = this.child;
      this.child = undefined;
      if (child) {
        this.terminateWorker(child);
      }
    }
    return Promise.all([...this.terminations.values()].map(({ promise }) => promise)).then(() => undefined);
  }

  private enqueue(payload: Record<string, unknown>): Promise<{ text: string }> {
    const work = this.serialTail.then(async () => {
      if (this.closed) {
        throw new VoiceVacError('TRANSCRIPTION_CANCELLED');
      }
      if (this.failure) {
        throw this.failure;
      }
      await this.start();
      if (this.closed) {
        throw new VoiceVacError('TRANSCRIPTION_CANCELLED');
      }
      if (this.failure) {
        throw this.failure;
      }
      return this.writeRequest(payload);
    });
    this.serialTail = work.then(() => undefined, () => undefined);
    return work;
  }

  private writeRequest(payload: Record<string, unknown>): Promise<{ text: string }> {
    const child = this.child;
    if (!child || this.status !== 'ready' || hasExited(child)) {
      return Promise.reject(new VoiceVacError('ASR_INFERENCE_FAILED'));
    }
    const id = `asr_${this.nextRequestId++}`;

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        phase: 'awaiting_accept',
        resolve,
        reject
      };
      this.pending.set(id, pending);
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (cause) {
        this.pending.delete(id);
        reject(new VoiceVacError('ASR_INFERENCE_FAILED', undefined, undefined, undefined, cause));
        return;
      }
      pending.timeout = this.armRequestTimeout(child, id, this.acceptTimeoutMs);
    });
  }

  private armRequestTimeout(
    child: ChildProcessWithoutNullStreams,
    id: string,
    milliseconds: number
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (!this.pending.has(id)) {
        return;
      }
      this.failWorker(child, new VoiceVacError('ASR_INFERENCE_TIMEOUT'));
    }, milliseconds);
    timer.unref();
    return timer;
  }

  private spawnWorker(): void {
    this.stderr = '';
    this.status = 'booting';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.pythonCommand, [this.options.workerPath], {
        env: {
          ...process.env,
          ...this.options.workerEnv,
          VOICE_VAC_QWEN_MODEL_PATH: this.options.modelPath ?? this.options.modelId ?? '',
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1'
        },
        stdio: 'pipe'
      });
    } catch (cause) {
      this.failStartWithoutChild(new VoiceVacError('ASR_RUNTIME_MISSING', undefined, undefined, undefined, cause));
      return;
    }

    this.child = child;
    this.armStartupHardDeadline(child);
    this.armStartupInactivity(child);
    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        this.handleFrameLine(child, line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
    child.stdin.on('error', (cause) => {
      this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED', undefined, undefined, undefined, cause));
    });
    child.once('error', (cause) => {
      this.finishTermination(child);
      const code = this.status === 'ready' ? 'ASR_INFERENCE_FAILED' : 'ASR_RUNTIME_MISSING';
      this.failWorker(child, new VoiceVacError(code, undefined, undefined, undefined, cause));
    });
    child.once('exit', () => {
      this.finishTermination(child);
      if (this.child !== child) {
        return;
      }
      const code = this.status === 'ready' ? 'ASR_INFERENCE_FAILED' : 'ASR_MODEL_LOAD_FAILED';
      this.failWorker(child, new VoiceVacError(code));
    });
  }

  private armStartupHardDeadline(child: ChildProcessWithoutNullStreams): void {
    this.startupHardTimer = setTimeout(() => {
      this.failWorker(child, new VoiceVacError('ASR_STARTUP_TIMEOUT'));
    }, this.startupHardTimeoutMs);
    this.startupHardTimer.unref();
  }

  private armStartupInactivity(child: ChildProcessWithoutNullStreams): void {
    if (this.startupInactivityTimer) {
      clearTimeout(this.startupInactivityTimer);
    }
    this.startupInactivityTimer = setTimeout(() => {
      this.failWorker(child, new VoiceVacError('ASR_STARTUP_TIMEOUT'));
    }, this.startupInactivityTimeoutMs);
    this.startupInactivityTimer.unref();
  }

  private handleFrameLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child || !line.trim()) {
      return;
    }
    let frame: WorkerFrame;
    try {
      frame = JSON.parse(line) as WorkerFrame;
    } catch (cause) {
      this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED', undefined, undefined, undefined, cause));
      return;
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
      return;
    }
    this.handleFrame(child, frame);
  }

  private handleFrame(child: ChildProcessWithoutNullStreams, frame: WorkerFrame): void {
    switch (frame.type) {
      case 'status': {
        if (
          !hasExactKeys(frame, ['type', 'status'])
          || this.status === 'ready'
          || (frame.status !== 'booting' && frame.status !== 'model_loading')
        ) {
          this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
          return;
        }
        this.status = frame.status;
        this.armStartupInactivity(child);
        return;
      }
      case 'ready': {
        if (
          !hasExactKeys(frame, ['type', 'model_id', 'device'])
          || this.status === 'ready'
          || typeof frame.model_id !== 'string'
          || !frame.model_id
          || typeof frame.device !== 'string'
          || !frame.device
        ) {
          this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
          return;
        }
        this.status = 'ready';
        this.clearStartupTimers();
        this.startDeferred?.resolve();
        this.startDeferred = undefined;
        return;
      }
      case 'fatal': {
        if (
          !hasExactKeys(frame, ['type', 'code', 'error', 'retryable'])
          || typeof frame.error !== 'string'
          || typeof frame.retryable !== 'boolean'
        ) {
          this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
          return;
        }
        const code = asVoiceVacErrorCode(frame.code) ?? 'ASR_MODEL_LOAD_FAILED';
        this.failWorker(child, new VoiceVacError(code));
        return;
      }
      case 'accepted': {
        if (!hasExactKeys(frame, ['type', 'id'])) {
          this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
          return;
        }
        const pending = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined;
        if (!pending || pending.phase !== 'awaiting_accept') {
          this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
          return;
        }
        clearPendingTimer(pending);
        pending.phase = 'inference';
        pending.timeout = this.armRequestTimeout(child, frame.id as string, this.inferenceTimeoutMs);
        return;
      }
      case 'result': {
        if (
          !hasExactKeys(frame, ['type', 'id', 'text', 'language'])
          || (frame.language !== null && typeof frame.language !== 'string')
        ) {
          this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
          return;
        }
        const pending = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined;
        if (!pending || pending.phase !== 'inference' || typeof frame.text !== 'string') {
          this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
          return;
        }
        clearPendingTimer(pending);
        this.pending.delete(frame.id as string);
        pending.resolve({ text: frame.text });
        return;
      }
      case 'error': {
        if (
          !hasExactKeys(frame, ['type', 'id', 'code', 'error', 'retryable'])
          || typeof frame.error !== 'string'
          || typeof frame.retryable !== 'boolean'
        ) {
          this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
          return;
        }
        const pending = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined;
        const code = asVoiceVacErrorCode(frame.code);
        if (!pending || !code) {
          this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
          return;
        }
        clearPendingTimer(pending);
        this.pending.delete(frame.id as string);
        pending.reject(new VoiceVacError(code));
        return;
      }
      default:
        this.failWorker(child, new VoiceVacError('ASR_INFERENCE_FAILED'));
    }
  }

  private failStartWithoutChild(error: VoiceVacError): void {
    this.clearStartupTimers();
    this.failure = error;
    this.status = 'fatal';
    this.startDeferred?.reject(error);
    this.startDeferred = undefined;
    this.rejectAll(error);
  }

  private failWorker(child: ChildProcessWithoutNullStreams, error: VoiceVacError): void {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    this.clearStartupTimers();
    this.failure = error;
    if (!this.closed) {
      this.status = 'fatal';
    }
    this.startDeferred?.reject(error);
    this.startDeferred = undefined;
    this.rejectAll(error);
    this.terminateWorker(child);
  }

  private clearStartupTimers(): void {
    if (this.startupInactivityTimer) {
      clearTimeout(this.startupInactivityTimer);
      this.startupInactivityTimer = undefined;
    }
    if (this.startupHardTimer) {
      clearTimeout(this.startupHardTimer);
      this.startupHardTimer = undefined;
    }
  }

  private rejectAll(error: Error): void {
    for (const { reject, timeout } of this.pending.values()) {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    }
    this.pending.clear();
  }

  private terminateWorker(child: ChildProcessWithoutNullStreams): Promise<void> {
    const existing = this.terminations.get(child);
    if (existing) {
      if (hasExited(child)) {
        this.finishTermination(child);
      }
      return existing.promise;
    }
    if (hasExited(child)) {
      return Promise.resolve();
    }

    let resolveTermination!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveTermination = resolve;
    });
    const graceTimer = setTimeout(() => {
      if (!hasExited(child)) {
        child.kill('SIGKILL');
      }
    }, this.terminationGraceMs);
    const hardTimer = setTimeout(
      () => this.finishTermination(child),
      this.terminationGraceMs * 2
    );
    graceTimer.unref();
    hardTimer.unref();
    this.terminations.set(child, { graceTimer, hardTimer, promise, resolve: resolveTermination });
    child.kill('SIGTERM');
    return promise;
  }

  private finishTermination(child: ChildProcessWithoutNullStreams): void {
    const termination = this.terminations.get(child);
    if (!termination) {
      return;
    }
    clearTimeout(termination.graceTimer);
    clearTimeout(termination.hardTimer);
    this.terminations.delete(child);
    termination.resolve();
  }
}

function asVoiceVacErrorCode(value: unknown): VoiceVacErrorCode | undefined {
  return typeof value === 'string' && ERROR_CODE_SET.has(value)
    ? value as VoiceVacErrorCode
    : undefined;
}

function clearPendingTimer(pending: PendingRequest): void {
  if (pending.timeout) {
    clearTimeout(pending.timeout);
    pending.timeout = undefined;
  }
}

function hasExactKeys(frame: WorkerFrame, expected: string[]): boolean {
  const actual = Object.keys(frame).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPositiveTimeout(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
