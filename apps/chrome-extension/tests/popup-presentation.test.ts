import { describe, expect, it } from 'vitest';

import type { CaptureState } from '../src/bridge.js';

describe('popup presentation', () => {
  it.each(['downloading', 'transcribing'] as const)(
    'turns the primary action into cancellation while %s',
    async (phase) => {
      const state: CaptureState = { active: false, mode: 'quality', phase };
      const presentation = await import(
        /* @vite-ignore */ new URL('../src/popup-presentation.ts', import.meta.url).href
      ).catch(() => undefined) as undefined | {
        captureActionKey: (capture: CaptureState) => string;
        isProcessingPhase: (value: CaptureState['phase']) => boolean;
      };

      expect(presentation?.isProcessingPhase(phase)).toBe(true);
      expect(presentation?.captureActionKey(state)).toBe('capture.cancelTranscription');
    }
  );
});
