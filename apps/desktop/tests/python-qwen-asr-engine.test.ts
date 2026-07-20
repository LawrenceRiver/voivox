import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VoiceVacError } from '@voivox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PythonQwenAsrEngine } from '../src/main/python-qwen-asr-engine.js';

const workerPath = fileURLToPath(new URL('./fixtures/protocol-asr-worker.cjs', import.meta.url));
const engines: PythonQwenAsrEngine[] = [];

function engine(
  scenario = 'ready',
  options: Partial<ConstructorParameters<typeof PythonQwenAsrEngine>[0]> = {}
): PythonQwenAsrEngine {
  const value = new PythonQwenAsrEngine({
    pythonCommand: process.execPath,
    workerPath,
    modelPath: '/models/Qwen3-ASR-0.6B',
    startupInactivityTimeoutMs: 1_000,
    startupHardTimeoutMs: 2_000,
    acceptTimeoutMs: 1_000,
    inferenceTimeoutMs: 1_000,
    terminationGraceMs: 100,
    workerEnv: { PROTOCOL_WORKER_SCENARIO: scenario },
    ...options
  });
  engines.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map(async (value) => value.close()));
});

describe('PythonQwenAsrEngine readiness', () => {
  it('keeps one start promise pending across boot/model_loading and resolves only on ready', async () => {
    const value = engine('delayed-ready', {
      workerEnv: { PROTOCOL_WORKER_SCENARIO: 'delayed-ready', PROTOCOL_WORKER_DELAY_MS: '120' }
    });
    const startA = value.start();
    const startB = value.start();

    expect(startA).toBe(startB);
    await waitFor(() => value.getStatus() === 'model_loading');
    expect(value.getStatus()).toBe('model_loading');
    expect(await Promise.race([startA.then(() => 'ready'), delay(20, 'pending')])).toBe('pending');
    await expect(startA).resolves.toBeUndefined();
    expect(value.getStatus()).toBe('ready');
  });

  it('never writes a request before the exact worker is ready', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'voice-vac-worker-'));
    const logPath = join(directory, 'received.ndjson');
    const value = engine('delayed-ready', {
      workerEnv: {
        PROTOCOL_WORKER_SCENARIO: 'delayed-ready',
        PROTOCOL_WORKER_DELAY_MS: '120',
        PROTOCOL_WORKER_RECEIVE_LOG: logPath
      }
    });

    try {
      const transcription = value.transcribeFile('/tmp/after-ready.wav');
      await new Promise((resolve) => setTimeout(resolve, 170));
      await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(transcription).resolves.toEqual({ text: 'transcript:/tmp/after-ready.wav' });
      expect(await readFile(logPath, 'utf8')).toContain('/tmp/after-ready.wav');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('lets startup status refresh inactivity but never the hard deadline', async () => {
    const active = engine('startup-hard-timeout', {
      startupInactivityTimeoutMs: 500,
      startupHardTimeoutMs: 800,
      workerEnv: { PROTOCOL_WORKER_SCENARIO: 'startup-hard-timeout', PROTOCOL_WORKER_DELAY_MS: '40' }
    });

    const startedAt = Date.now();
    await expect(active.start()).rejects.toMatchObject({ code: 'ASR_STARTUP_TIMEOUT' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(650);
    expect(Date.now() - startedAt).toBeLessThan(1_500);

    const silent = engine('startup-inactivity-timeout', {
      startupInactivityTimeoutMs: 500,
      startupHardTimeoutMs: 2_000
    });
    await expect(silent.start()).rejects.toMatchObject({ code: 'ASR_STARTUP_TIMEOUT' });
  });

  it('sets the exact offline model environment', async () => {
    const source = await readFile(new URL('../src/main/python-qwen-asr-engine.ts', import.meta.url), 'utf8');
    expect(source).toContain('VOICE_VAC_QWEN_MODEL_PATH');
    expect(source).toContain("HF_HUB_OFFLINE: '1'");
    expect(source).toContain("TRANSFORMERS_OFFLINE: '1'");
    expect(source).not.toContain('VOIVOX_QWEN_MODEL');
  });
});

describe('PythonQwenAsrEngine request phases', () => {
  it('starts accept timeout only after the ready worker write', async () => {
    const value = engine('slow-accept', {
      acceptTimeoutMs: 120,
      startupHardTimeoutMs: 2_000,
      workerEnv: { PROTOCOL_WORKER_SCENARIO: 'slow-accept', PROTOCOL_WORKER_DELAY_MS: '300' }
    });
    await expect(value.transcribeFile('/tmp/no-accept.wav')).rejects.toMatchObject({ code: 'ASR_INFERENCE_TIMEOUT' });
  });

  it('starts the inference timeout only after accepted', async () => {
    const value = engine('slow-accept', {
      acceptTimeoutMs: 500,
      inferenceTimeoutMs: 80,
      workerEnv: { PROTOCOL_WORKER_SCENARIO: 'slow-accept', PROTOCOL_WORKER_DELAY_MS: '220' }
    });
    await expect(value.transcribeFile('/tmp/accepted-late.wav')).resolves.toEqual({ text: 'transcript:/tmp/accepted-late.wav' });

    const noResult = engine('no-result', { inferenceTimeoutMs: 120 });
    await expect(noResult.transcribeFile('/tmp/no-result.wav')).rejects.toMatchObject({ code: 'ASR_INFERENCE_TIMEOUT' });
  });

  it('does not count queue waiting toward inference and never overlaps requests', async () => {
    const value = engine('serial', {
      inferenceTimeoutMs: 400,
      workerEnv: { PROTOCOL_WORKER_SCENARIO: 'serial', PROTOCOL_WORKER_DELAY_MS: '180' }
    });
    const first = value.transcribeFile('/tmp/first.wav');
    const second = value.transcribeFile('/tmp/second.wav');

    await expect(first).resolves.toEqual({ text: 'transcript:/tmp/first.wav' });
    await expect(second).resolves.toEqual({ text: 'transcript:/tmp/second.wav' });
  });

  it('preserves a stable fatal worker code', async () => {
    const value = engine('fatal-startup', {
      workerEnv: { PROTOCOL_WORKER_SCENARIO: 'fatal-startup', PROTOCOL_WORKER_FATAL_CODE: 'ASR_MODEL_MISSING' }
    });
    await expect(value.start()).rejects.toMatchObject({ code: 'ASR_MODEL_MISSING' });

    const duringRequest = engine('fatal-request', {
      workerEnv: { PROTOCOL_WORKER_SCENARIO: 'fatal-request', PROTOCOL_WORKER_FATAL_CODE: 'ASR_RUNTIME_MISSING' }
    });
    await expect(duringRequest.transcribeFile('/tmp/fatal.wav')).rejects.toMatchObject({ code: 'ASR_RUNTIME_MISSING' });
    await expect(duringRequest.transcribeFile('/tmp/after-fatal.wav')).rejects.toMatchObject({ code: 'ASR_RUNTIME_MISSING' });
  });

  it('terminates on malformed protocol frames instead of ignoring them', async () => {
    const startup = engine('malformed-startup');
    await expect(startup.start()).rejects.toBeInstanceOf(VoiceVacError);

    const result = engine('malformed-response');
    await expect(result.transcribeFile('/tmp/malformed.wav')).rejects.toMatchObject({ code: 'ASR_INFERENCE_FAILED' });
  });
});

describe('PythonQwenAsrEngine shutdown', () => {
  it('rejects queued and active work immediately when closed', async () => {
    const value = engine('no-result', { inferenceTimeoutMs: 60_000 });
    const active = value.transcribeFile('/tmp/active.wav');
    const queued = value.transcribeFile('/tmp/queued.wav');
    await waitFor(() => value.getStatus() === 'ready');

    const closing = value.close();
    await expect(active).rejects.toMatchObject({ code: 'TRANSCRIPTION_CANCELLED' });
    await expect(queued).rejects.toMatchObject({ code: 'TRANSCRIPTION_CANCELLED' });
    await closing;
  });

  it('escalates SIGTERM to SIGKILL within a bounded grace period', async () => {
    const value = engine('stubborn', { terminationGraceMs: 120 });
    await value.start();
    const child = (value as unknown as { child: { kill: (signal?: NodeJS.Signals) => boolean } }).child;
    const kill = vi.spyOn(child, 'kill');

    const outcome = await Promise.race([value.close().then(() => 'closed'), delay(2_000, 'timeout')]);
    expect(outcome).toBe('closed');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });
});

function delay<T>(milliseconds: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), milliseconds));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await delay(10, undefined);
  }
  throw new Error('condition was not reached');
}
