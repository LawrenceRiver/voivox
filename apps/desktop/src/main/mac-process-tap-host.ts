import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type MacAudioProcess = {
  bundleId: string;
  name: string;
  pid: number;
};

type ActiveRecording = {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<{ code: number | null; stderr: string; stdout: string }>;
  directory: string;
  outputPath: string;
};

type ProcessTapHostOptions = {
  commandTimeoutMs?: number;
  startTimeoutMs?: number;
  terminationGraceMs?: number;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const timedOut = Symbol('timedOut');

export class MacProcessTapHost {
  private readonly recordings = new Map<string, ActiveRecording>();
  private readonly commandTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly terminationGraceMs: number;

  constructor(
    private readonly binaryPath: string,
    options: ProcessTapHostOptions = {}
  ) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    if (
      !isPositiveTimeout(this.commandTimeoutMs)
      || !isPositiveTimeout(this.startTimeoutMs)
      || !isPositiveTimeout(this.terminationGraceMs)
    ) {
      throw new Error('VOIVOX process host timeouts must be positive numbers.');
    }
  }

  async listProcesses(): Promise<MacAudioProcess[]> {
    const child = spawn(this.binaryPath, ['list'], { stdio: 'pipe' });
    const completion = collect(child);
    const outcome = await settleWithin(completion, this.commandTimeoutMs);
    if (outcome === timedOut) {
      await terminateChild(child, completion, 'SIGTERM', this.terminationGraceMs);
      throw new Error(`VOIVOX process host did not list apps within ${this.commandTimeoutMs} ms.`);
    }
    const output = outcome;
    const parsed: unknown = JSON.parse(output.stdout);
    if (!Array.isArray(parsed)) {
      throw new Error('VOIVOX process host returned an invalid process list.');
    }
    return parsed.filter(isMacAudioProcess);
  }

  async start(sessionId: string, pid: number): Promise<void> {
    if (this.recordings.has(sessionId)) {
      throw new Error('This VOIVOX process capture is already running.');
    }
    const directory = await mkdtemp(join(tmpdir(), 'voivox-process-'));
    const outputPath = join(directory, 'capture.wav');
    const child = spawn(this.binaryPath, ['record', String(pid), outputPath], { stdio: 'pipe' });
    const recording = { child, completion: collect(child), directory, outputPath };
    this.recordings.set(sessionId, recording);

    try {
      await waitForStart(child, this.startTimeoutMs);
    } catch (error) {
      await terminateChild(child, recording.completion, 'SIGINT', this.terminationGraceMs);
      this.recordings.delete(sessionId);
      await rm(directory, { force: true, recursive: true });
      throw error;
    }
  }

  async stop(sessionId: string): Promise<string | undefined> {
    const recording = this.recordings.get(sessionId);
    if (!recording) {
      return undefined;
    }
    const result = await terminateChild(
      recording.child,
      recording.completion,
      'SIGINT',
      this.terminationGraceMs
    );
    this.recordings.delete(sessionId);
    if (result.code !== 0) {
      await rm(recording.directory, { force: true, recursive: true });
      throw new Error(result.stderr || 'VOIVOX process host could not stop the capture.');
    }
    return recording.outputPath;
  }

  async discard(sessionId: string): Promise<void> {
    const recording = this.recordings.get(sessionId);
    if (!recording) {
      return;
    }
    await terminateChild(
      recording.child,
      recording.completion,
      'SIGINT',
      this.terminationGraceMs
    );
    this.recordings.delete(sessionId);
    await rm(recording.directory, { force: true, recursive: true });
  }

  async discardAll(): Promise<void> {
    await Promise.all([...this.recordings.keys()].map((sessionId) => this.discard(sessionId)));
  }
}

function isMacAudioProcess(value: unknown): value is MacAudioProcess {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const process = value as Partial<MacAudioProcess>;
  return typeof process.pid === 'number' && typeof process.name === 'string' && typeof process.bundleId === 'string';
}

function waitForStart(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => reject(new Error(`VOIVOX process host did not start within ${timeoutMs} ms.`)),
      timeoutMs
    );
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.split('\n').some((line) => line.includes('"event":"started"'))) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(stderr || 'VOIVOX process host exited before recording began.'));
    });
  });
}

function collect(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr, stdout }));
  });
}

async function terminateChild<T>(
  child: ChildProcessWithoutNullStreams,
  completion: Promise<T>,
  gracefulSignal: NodeJS.Signals,
  graceMs: number
): Promise<T> {
  if (!hasExited(child)) {
    child.kill(gracefulSignal);
  }
  const graceful = await settleWithin(completion, graceMs);
  if (graceful !== timedOut) {
    return graceful;
  }

  if (!hasExited(child)) {
    child.kill('SIGKILL');
  }
  const forced = await settleWithin(completion, graceMs);
  if (forced !== timedOut) {
    return forced;
  }
  throw new Error('VOIVOX process host could not be terminated.');
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof timedOut> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), timeoutMs);
        timeout.unref();
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPositiveTimeout(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
