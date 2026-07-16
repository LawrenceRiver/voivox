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

export class MacProcessTapHost {
  private readonly recordings = new Map<string, ActiveRecording>();

  constructor(private readonly binaryPath: string) {}

  async listProcesses(): Promise<MacAudioProcess[]> {
    const child = spawn(this.binaryPath, ['list'], { stdio: 'pipe' });
    const output = await collect(child);
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
      await waitForStart(child);
    } catch (error) {
      this.recordings.delete(sessionId);
      child.kill('SIGINT');
      await recording.completion.catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
      throw error;
    }
  }

  async stop(sessionId: string): Promise<string | undefined> {
    const recording = this.recordings.get(sessionId);
    if (!recording) {
      return undefined;
    }
    this.recordings.delete(sessionId);
    if (recording.child.exitCode === null && !recording.child.killed) {
      recording.child.kill('SIGINT');
    }
    const result = await recording.completion;
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
    this.recordings.delete(sessionId);
    if (recording.child.exitCode === null && !recording.child.killed) {
      recording.child.kill('SIGINT');
    }
    await recording.completion.catch(() => undefined);
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

function waitForStart(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error('VOIVOX process host did not start within 10 seconds.')), 10_000);
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
