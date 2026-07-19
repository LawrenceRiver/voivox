export type PvttState =
  | 'idle'
  | 'detecting'
  | 'ready'
  | 'connecting'
  | 'transcribing'
  | 'paused'
  | 'returning'
  | 'completed'
  | 'failed';

export type PvttStatus = PvttState;

export type PvttEvent =
  | { type: 'detect' }
  | { type: 'ready' }
  | { type: 'connect' }
  | { type: 'transcribe' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'return' }
  | { type: 'complete' }
  | { type: 'fail' }
  | { type: 'retry' }
  | { type: 'reset' };

const transitions: Record<PvttState, Partial<Record<PvttEvent['type'], PvttState>>> = {
  idle: { detect: 'detecting', reset: 'idle' },
  detecting: { ready: 'ready', fail: 'failed', reset: 'idle' },
  ready: { connect: 'connecting', detect: 'detecting', fail: 'failed', reset: 'idle' },
  connecting: { transcribe: 'transcribing', fail: 'failed', reset: 'idle' },
  transcribing: { pause: 'paused', return: 'returning', fail: 'failed', reset: 'idle' },
  paused: { resume: 'transcribing', return: 'returning', fail: 'failed', reset: 'idle' },
  returning: { complete: 'completed', fail: 'failed', reset: 'idle' },
  completed: { detect: 'detecting', reset: 'idle' },
  failed: { retry: 'detecting', reset: 'idle' }
};

export function nextPvttState(current: PvttState, event: PvttEvent): PvttState {
  const next = transitions[current][event.type];
  if (!next) {
    throw new Error(`Invalid PVTT state transition: ${current} + ${event.type}`);
  }
  return next;
}
