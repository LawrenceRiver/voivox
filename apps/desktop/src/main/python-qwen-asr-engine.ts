import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { LocalAsrEngine } from './asr-pipeline.js';

type PendingRequest = {
  reject: (error: Error) => void;
  resolve: (value: { text: string }) => void;
};

export class PythonQwenAsrEngine implements LocalAsrEngine {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private stderr = '';

  constructor(
    private readonly options: {
      modelId?: string;
      pythonCommand: string;
      workerPath: string;
    }
  ) {}

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
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
    });
  }

  close(): void {
    this.child?.kill();
    this.child = undefined;
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
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
    child.on('error', (error) => this.rejectAll(error));
    child.on('exit', () => {
      this.child = undefined;
      this.rejectAll(new Error(this.stderr || 'The local Qwen ASR worker stopped unexpectedly.'));
    });
    this.child = child;
    return child;
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
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }
}
