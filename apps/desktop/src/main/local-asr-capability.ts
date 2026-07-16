import { spawn } from 'node:child_process';

import type { LocalAsrStatus } from '@voivox/core';

export type PythonProbeRunner = (pythonCommand: string, args: string[]) => Promise<number>;

export type LocalAsrCapabilityProbe = {
  completion: Promise<LocalAsrStatus>;
  getStatus: () => LocalAsrStatus;
};

const FIND_RUNTIME_SCRIPT = [
  'import importlib.util',
  "raise SystemExit(0 if importlib.util.find_spec('mlx_qwen3_asr') is not None else 1)"
].join('\n');

export function startLocalAsrCapabilityProbe(
  pythonCommand: string,
  run: PythonProbeRunner = runPythonProbe
): LocalAsrCapabilityProbe {
  let status: LocalAsrStatus = 'checking';
  let execution: Promise<number>;
  try {
    execution = run(pythonCommand, ['-c', FIND_RUNTIME_SCRIPT]);
  } catch (error) {
    execution = Promise.reject(error);
  }
  const completion = execution.then(
    (exitCode): LocalAsrStatus => {
      status = exitCode === 0 ? 'ready' : 'missing';
      return status;
    },
    (): LocalAsrStatus => {
      status = 'missing';
      return status;
    }
  );

  return {
    completion,
    getStatus: () => status
  };
}

function runPythonProbe(pythonCommand: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(pythonCommand, args, { stdio: 'ignore' });
    let settled = false;
    const finish = (exitCode: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(exitCode);
    };
    child.once('error', () => finish(1));
    child.once('exit', (exitCode) => finish(exitCode ?? 1));
  });
}
