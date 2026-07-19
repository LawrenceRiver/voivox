import type { LocalAsrStatus } from '@voivox/core';

import type { PythonQwenAsrStatus } from './python-qwen-asr-engine.js';

export type LocalAsrCapabilityProbe = {
  completion: Promise<LocalAsrStatus>;
  getStatus: () => LocalAsrStatus;
};

export type LocalAsrReadinessSource = {
  getStatus: () => PythonQwenAsrStatus;
  start: () => Promise<void>;
};

export function startLocalAsrCapabilityProbe(
  source: LocalAsrReadinessSource | string
): LocalAsrCapabilityProbe {
  let status: LocalAsrStatus = 'checking';
  const completion = typeof source === 'string'
    ? Promise.resolve<LocalAsrStatus>('missing')
    : startExactEngine(source);

  const trackedCompletion = completion.then((nextStatus) => {
    status = nextStatus;
    return nextStatus;
  });

  return {
    completion: trackedCompletion,
    getStatus: () => {
      if (typeof source !== 'string' && (source.getStatus() === 'fatal' || source.getStatus() === 'closed')) {
        status = 'missing';
      }
      return status;
    }
  };
}

async function startExactEngine(source: LocalAsrReadinessSource): Promise<LocalAsrStatus> {
  try {
    await source.start();
    return source.getStatus() === 'ready' ? 'ready' : 'missing';
  } catch {
    return 'missing';
  }
}
