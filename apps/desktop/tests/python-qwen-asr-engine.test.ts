import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { PythonQwenAsrEngine } from '../src/main/python-qwen-asr-engine.js';

const silentWorkerPath = fileURLToPath(new URL('./fixtures/silent-asr-worker.cjs', import.meta.url));
const stubbornWorkerPath = fileURLToPath(new URL('./fixtures/stubborn-asr-worker.cjs', import.meta.url));

type TestChild = {
  kill: (signal?: NodeJS.Signals | number) => boolean;
  once: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  signalCode: NodeJS.Signals | null;
  stdin: { emit: (event: string, error: Error) => boolean };
  stdout: { once: (event: 'data', listener: () => void) => void };
};

function workerOf(engine: PythonQwenAsrEngine): TestChild {
  return (engine as unknown as { child: TestChild }).child;
}

describe('PythonQwenAsrEngine', () => {
  it('rejects and terminates a worker that does not answer before the configured timeout', async () => {
    const engine = new PythonQwenAsrEngine({
      pythonCommand: process.execPath,
      requestTimeoutMs: 25,
      workerPath: silentWorkerPath
    });

    try {
      const outcome = await Promise.race([
        engine.transcribeFile('/tmp/voivox-silent.wav').then(
          () => 'resolved',
          (error: unknown) => error instanceof Error ? error.message : String(error)
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 250))
      ]);

      expect(outcome).toBe('VOIVOX local ASR timed out after 25 ms.');
    } finally {
      await engine.close();
    }
  });

  it('rejects pending work immediately when the engine closes', async () => {
    const engine = new PythonQwenAsrEngine({
      pythonCommand: process.execPath,
      requestTimeoutMs: 60_000,
      workerPath: silentWorkerPath
    });
    const transcription = engine.transcribeFile('/tmp/voivox-closing.wav');

    const closing = engine.close();
    const outcome = await Promise.race([
      transcription.then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error)
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 100))
    ]);

    expect(outcome).toBe('VOIVOX local ASR stopped.');
    await closing;
  });

  it('handles an asynchronous worker stdin error without throwing an uncaught exception', async () => {
    const engine = new PythonQwenAsrEngine({
      pythonCommand: process.execPath,
      requestTimeoutMs: 60_000,
      workerPath: silentWorkerPath
    });
    const transcription = engine.transcribeFile('/tmp/voivox-broken-pipe.wav');
    const child = workerOf(engine);
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

    expect(() => child.stdin.emit('error', error)).not.toThrow();
    await expect(transcription).rejects.toThrow('write EPIPE');
    await engine.close();
  });

  it('escalates from SIGTERM to SIGKILL when a timed-out worker ignores termination', async () => {
    const engine = new PythonQwenAsrEngine({
      pythonCommand: process.execPath,
      requestTimeoutMs: 300,
      terminationGraceMs: 25,
      workerPath: stubbornWorkerPath
    });
    const transcription = engine.transcribeFile('/tmp/voivox-stubborn.wav');
    const child = workerOf(engine);
    await new Promise<void>((resolve) => child.stdout.once('data', resolve));
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once('exit', (_code, signal) => resolve(signal));
    });

    try {
      await expect(transcription).rejects.toThrow('VOIVOX local ASR timed out after 300 ms.');
      const signal = await Promise.race([
        exited,
        new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), 250))
      ]);

      expect(signal).toBe('SIGKILL');
    } finally {
      if (child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await engine.close();
    }
  });

  it('waits for a stubborn current worker to exit before close resolves', async () => {
    const engine = new PythonQwenAsrEngine({
      pythonCommand: process.execPath,
      requestTimeoutMs: 60_000,
      terminationGraceMs: 25,
      workerPath: stubbornWorkerPath
    });
    const transcription = engine.transcribeFile('/tmp/voivox-stubborn-close.wav');
    const child = workerOf(engine);
    await new Promise<void>((resolve) => child.stdout.once('data', resolve));
    const exited = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once('exit', (_code, signal) => resolve(signal));
    });
    let closeResolved = false;

    try {
      const closing = Promise.resolve(engine.close()).then(() => {
        closeResolved = true;
      });
      await expect(transcription).rejects.toThrow('VOIVOX local ASR stopped.');
      await Promise.resolve();
      expect(closeResolved).toBe(false);
      await expect(exited).resolves.toBe('SIGKILL');
      await closing;
      expect(closeResolved).toBe(true);
    } finally {
      if (child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  });

  it('waits for a worker that had already timed out before close was called', async () => {
    const engine = new PythonQwenAsrEngine({
      pythonCommand: process.execPath,
      requestTimeoutMs: 300,
      terminationGraceMs: 100,
      workerPath: stubbornWorkerPath
    });
    const transcription = engine.transcribeFile('/tmp/voivox-timeout-then-close.wav');
    const child = workerOf(engine);
    await new Promise<void>((resolve) => child.stdout.once('data', resolve));

    try {
      await expect(transcription).rejects.toThrow('VOIVOX local ASR timed out after 300 ms.');
      const closeOutcome = await Promise.race([
        Promise.resolve(engine.close()).then(() => 'closed'),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 25))
      ]);

      expect(closeOutcome).toBe('waiting');
      await engine.close();
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      if (child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  });

  it('cancels forced termination when a worker exits during the SIGTERM grace period', async () => {
    const engine = new PythonQwenAsrEngine({
      pythonCommand: process.execPath,
      requestTimeoutMs: 60_000,
      terminationGraceMs: 50,
      workerPath: silentWorkerPath
    });
    const transcription = engine.transcribeFile('/tmp/voivox-graceful-close.wav');
    const child = workerOf(engine);
    const kill = vi.spyOn(child, 'kill');
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

    const closing = engine.close();
    await expect(transcription).rejects.toThrow('VOIVOX local ASR stopped.');
    await exited;
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps close bounded even if process exit is never observed after SIGKILL', async () => {
    const engine = new PythonQwenAsrEngine({
      pythonCommand: process.execPath,
      requestTimeoutMs: 60_000,
      terminationGraceMs: 25,
      workerPath: silentWorkerPath
    });
    const transcription = engine.transcribeFile('/tmp/voivox-unobservable-exit.wav');
    const transcriptionError = transcription.catch((error: unknown) => error);
    const child = workerOf(engine);
    const kill = vi.spyOn(child, 'kill').mockReturnValue(true);

    const outcome = await Promise.race([
      Promise.resolve(engine.close()).then(() => 'closed'),
      new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 250))
    ]);
    await expect(transcriptionError).resolves.toMatchObject({ message: 'VOIVOX local ASR stopped.' });

    expect(outcome).toBe('closed');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    kill.mockRestore();
    child.kill('SIGKILL');
  });

  it('does not reuse a worker whose process has already exited', async () => {
    const source = await readFile(new URL('../src/main/python-qwen-asr-engine.ts', import.meta.url), 'utf8');

    expect(source).toContain('this.child.exitCode === null');
  });
});
