import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { LocalAsrEngine } from './asr-pipeline.js';

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: { text: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type WorkerTermination = {
  graceTimer: ReturnType<typeof setTimeout>;
  hardTimer: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

export class PythonQwenAsrEngine implements LocalAsrEngine {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private readonly requestTimeoutMs: number;
  private stderr = '';
  private readonly terminationGraceMs: number;
  private readonly terminations = new Map<ChildProcessWithoutNullStreams, WorkerTermination>();

  constructor(
    private readonly options: {
      modelId?: string;
      pythonCommand: string;
      requestTimeoutMs?: number;
      terminationGraceMs?: number;
      workerPath: string;
    }
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    if (
      !isPositiveTimeout(this.requestTimeoutMs)
      || !isPositiveTimeout(this.terminationGraceMs)
    ) {
      throw new Error('Voice Vac local ASR timeouts must be positive numbers.');
    }
  }

  async transcribe(audio: {
    pcm: Uint8Array;
    sampleRate: 16_000;
    channels: 1;
  }): Promise<{ text: string }> {
    return this.request({
      pcm: Buffer.from(audio.pcm).toString('base64'),
      sampleRate: audio.sampleRate,
      channels: audio.channels
    });
  }

  async transcribeFile(audioPath: string): Promise<{ text: string }> {
    return this.request({ audioPath });
  }

  private async request(payload: Record<string, unknown>): Promise<{ text: string }> {
    const child = this.ensureWorker();
    const id = `asr_${this.nextRequestId++}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }
        const error = new Error(`Voice Vac local ASR timed out after ${this.requestTimeoutMs} ms.`);
        if (this.child === child) {
          this.child = undefined;
        }
        this.rejectAll(error);
        this.terminateWorker(child);
      }, this.requestTimeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout });
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.rejectAll(new Error('Voice Vac local ASR stopped.'));
    if (child) {
      this.terminateWorker(child);
    }
    return Promise.all([...this.terminations.values()].map(({ promise }) => promise)).then(() => undefined);
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }

    this.stderr = '';
    const child = spawn(this.options.pythonCommand, [this.options.workerPath], {
      env: { ...process.env, VOIVOX_QWEN_MODEL: this.options.modelId ?? 'Qwen/Qwen3-ASR-0.6B' },
      stdio: 'pipe'
    });
    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      lines.forEach((line) => this.handleResponse(line));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
    child.stdin.on('error', (error) => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.rejectAll(error);
      this.terminateWorker(child);
    });
    child.on('error', (error) => {
      this.finishTermination(child);
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.rejectAll(error);
    });
    child.on('exit', () => {
      this.finishTermination(child);
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.rejectAll(new Error(this.stderr || 'The local Qwen ASR worker stopped unexpectedly.'));
    });
    this.child = child;
    return child;
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
    this.terminations.set(child, {
      graceTimer,
      hardTimer,
      promise,
      resolve: resolveTermination
    });
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

  private handleResponse(line: string): void {
    if (!line.trim()) {
      return;
    }

    let response: { id?: unknown; text?: unknown; error?: unknown };
    try {
      response = JSON.parse(line) as { id?: unknown; text?: unknown; error?: unknown };
    } catch {
      return;
    }

    if (typeof response.id !== 'string') {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (typeof response.error === 'string') {
      pending.reject(new Error(response.error));
      return;
    }
    if (typeof response.text !== 'string') {
      pending.reject(new Error('The local Qwen ASR worker returned an invalid result.'));
      return;
    }
    pending.resolve({ text: response.text });
  }

  private rejectAll(error: Error): void {
    this.pending.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(error);
    });
    this.pending.clear();
  }
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPositiveTimeout(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
