import { describe, expect, it, vi } from 'vitest';

import {
  AsrWorkerClient,
  type AsrWorkerLike
} from '../src/asr-worker-client.js';
import * as asrWorkerClientModule from '../src/asr-worker-client.js';
import type { BrowserTranscriberState } from '../src/browser-transcriber.js';

describe('AsrWorkerClient', () => {
  it('transfers audio, forwards state, and resolves the correlated transcript', async () => {
    const worker = new FakeWorker();
    const states: BrowserTranscriberState[] = [];
    const client = new AsrWorkerClient(worker, (state) => states.push(state));
    const audio = new Float32Array([0.25, -0.5]);

    const transcript = client.transcribe(audio, 'quality');
    const request = worker.messages[0]?.message as { audio: ArrayBuffer; requestId: string };
    expect(new Float32Array(request.audio)).toEqual(new Float32Array([0.25, -0.5]));
    expect(worker.messages[0]?.transfer).toEqual([request.audio]);

    const state: BrowserTranscriberState = { mode: 'quality', phase: 'transcribing' };
    worker.emit({ state, type: 'state' });
    worker.emit({ requestId: request.requestId, text: '转写结果', type: 'result' });

    await expect(transcript).resolves.toBe('转写结果');
    expect(states).toEqual([state]);
  });

  it('supports retry and rejects a correlated model error', async () => {
    const worker = new FakeWorker();
    const client = new AsrWorkerClient(worker);

    const retry = client.retry();
    const request = worker.messages[0]?.message as { requestId: string; type: string };
    expect(request.type).toBe('retry');
    worker.emit({ message: 'model interrupted', requestId: request.requestId, type: 'error' });

    await expect(retry).rejects.toThrow('model interrupted');
  });

  it('disposes and terminates the dedicated worker', async () => {
    const worker = new FakeWorker();
    const client = new AsrWorkerClient(worker);

    const disposal = client.dispose();
    const request = worker.messages[0]?.message as { requestId: string };
    worker.emit({ requestId: request.requestId, type: 'disposed' });

    await expect(disposal).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('force-terminates a worker that never acknowledges disposal', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new AsrWorkerClient(worker);

    const disposal = client.dispose();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(disposal).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('cancels pending transcription by terminating the worker', async () => {
    const worker = new FakeWorker();
    const client = new AsrWorkerClient(worker);
    const pending = client.transcribe(new Float32Array([0.1]), 'quality');

    (client as unknown as { cancel: () => void }).cancel();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('watchdogs a transcription worker that never responds', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const ConfigurableClient = AsrWorkerClient as unknown as new (
      worker: AsrWorkerLike,
      onStateChange: ((state: BrowserTranscriberState) => void) | undefined,
      onFatalError: ((error: Error) => void) | undefined,
      options: { transcriptionWatchdogMs: () => number }
    ) => AsrWorkerClient;
    const failures: Error[] = [];
    const client = new ConfigurableClient(
      worker,
      undefined,
      (error) => failures.push(error),
      { transcriptionWatchdogMs: () => 1_000 }
    );
    const pending = client.transcribe(new Float32Array([0.1]), 'fast');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });

    await vi.advanceTimersByTimeAsync(1_000);

    await rejected;
    expect(failures).toHaveLength(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('clears the transcription watchdog after a successful result', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new AsrWorkerClient(worker, undefined, undefined, {
      transcriptionWatchdogMs: () => 1_000
    });
    const transcript = client.transcribe(new Float32Array([0.1]), 'fast');
    const request = worker.messages[0]?.message as { requestId: string };

    expect(vi.getTimerCount()).toBe(1);
    worker.emit({ requestId: request.requestId, text: 'done', type: 'result' });

    await expect(transcript).resolves.toBe('done');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('uses a finite, generous watchdog for first download and ten-minute audio', () => {
    const watchdog = (
      asrWorkerClientModule as unknown as {
        transcriptionWatchdogMs?: (sampleCount: number, mode: 'fast' | 'quality') => number;
      }
    ).transcriptionWatchdogMs;

    expect(typeof watchdog).toBe('function');
    expect(watchdog?.(16_000, 'quality')).toBeGreaterThanOrEqual(30 * 60_000);
    const tenMinutes = watchdog?.(16_000 * 10 * 60, 'quality') ?? Infinity;
    expect(Number.isFinite(tenMinutes)).toBe(true);
    expect(tenMinutes).toBeGreaterThanOrEqual(90 * 60_000);
  });

  it.each(['error', 'messageerror'] as const)(
    'rejects pending work and reports a fatal worker %s',
    async (eventType) => {
      const worker = new FakeWorker();
      const failures: Error[] = [];
      const client = new AsrWorkerClient(worker, undefined, (error) => failures.push(error));
      const pending = client.transcribe(new Float32Array([0.1]), 'fast');

      worker.emitEvent(eventType);

      await expect(pending).rejects.toThrow('worker');
      expect(failures).toHaveLength(1);
      expect(worker.terminate).toHaveBeenCalledOnce();
    }
  );
});

class FakeWorker implements AsrWorkerLike {
  readonly messages: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  readonly terminate = vi.fn();
  private readonly listeners = new Map<string, EventListener>();

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.messages.push({ message, transfer });
  }

  emit(data: unknown): void {
    this.listeners.get('message')?.({ data } as MessageEvent);
  }

  emitEvent(type: 'error' | 'messageerror'): void {
    this.listeners.get(type)?.(new Event(type));
  }
}
