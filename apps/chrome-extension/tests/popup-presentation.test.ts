import { describe, expect, it } from 'vitest';

import type { CaptureState } from '../src/bridge.js';
import {
  captureActionKey,
  captureCommandForState,
  captureGlyphForState,
  isProcessingPhase
} from '../src/popup-presentation.js';

describe('popup presentation', () => {
  it.each(['downloading', 'transcribing'] as const)(
    'turns the primary action into cancellation while %s',
    async (phase) => {
      const state: CaptureState = { active: false, mode: 'quality', phase };
      expect(isProcessingPhase(phase)).toBe(true);
      expect(captureCommandForState(state)).toBe('capture-stop');
      expect(captureActionKey(state)).toBe('capture.cancelTranscription');
    }
  );

  it.each([
    ['idle', 'capture-start', '▶'],
    ['armed', 'capture-start', '▶'],
    ['capturing', 'capture-pause', 'Ⅱ'],
    ['paused', 'capture-resume', '▶'],
    ['downloading', 'capture-stop', '■'],
    ['transcribing', 'capture-stop', '■'],
    ['complete', 'capture-start', '▶'],
    ['error', 'capture-start', '▶']
  ] as const)('maps %s to an explicit %s command', (phase, command, glyph) => {
    const state: CaptureState = {
      active: phase === 'capturing',
      mode: 'quality',
      phase
    };

    expect(captureCommandForState(state)).toBe(command);
    expect(captureGlyphForState(state)).toBe(glyph);
  });

  it('does not let a stale active flag turn an armed session into stop', () => {
    expect(captureCommandForState({ active: true, mode: 'quality', phase: 'armed' }))
      .toBe('capture-start');
  });
});
