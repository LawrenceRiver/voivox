import { describe, expect, it } from 'vitest';

import { nextPvttState, type PvttEvent, type PvttState } from '../src/pvtt-state.js';

describe('PVTT state machine', () => {
  it('moves through the MCP monitor lifecycle', () => {
    const events: PvttEvent[] = [
      { type: 'detect' },
      { type: 'ready' },
      { type: 'connect' },
      { type: 'transcribe' },
      { type: 'return' },
      { type: 'complete' }
    ];

    const states = events.reduce<PvttState[]>(
      (history, event) => [...history, nextPvttState(history.at(-1) ?? 'idle', event)],
      ['idle']
    );

    expect(states).toEqual([
      'idle',
      'detecting',
      'ready',
      'connecting',
      'transcribing',
      'returning',
      'completed'
    ]);
  });

  it('supports pause and resume while transcribing', () => {
    expect(nextPvttState('transcribing', { type: 'pause' })).toBe('paused');
    expect(nextPvttState('paused', { type: 'resume' })).toBe('transcribing');
  });

  it('returns to idle after retry and rejects impossible transitions', () => {
    expect(nextPvttState('failed', { type: 'retry' })).toBe('detecting');
    expect(() => nextPvttState('idle', { type: 'complete' })).toThrow('Invalid PVTT state transition');
  });
});
