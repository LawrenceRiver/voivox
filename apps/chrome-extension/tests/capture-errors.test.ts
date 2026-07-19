import { describe, expect, it } from 'vitest';

import {
  CAPTURE_ERROR_CODES,
  captureError,
  normalizeCaptureErrorCode
} from '../src/capture-errors.js';

describe('capture error catalog', () => {
  it.each([
    ['TAB_NOT_ARMED', 'Click the Voice VAC extension on this tab to arm it.'],
    ['NO_PLAYABLE_MEDIA', 'No playable video found here.'],
    ['USER_PLAY_REQUIRED', 'Press play once in Chrome.'],
    ['EMBEDDED_PLAYER_CLICK_REQUIRED', 'This embedded player needs one click to start.'],
    ['TAB_FROZEN', 'This tab is asleep. Bring it forward to continue.'],
    ['TARGET_NAVIGATED', 'The page changed. Arm this tab again.']
  ] as const)('maps %s to stable English copy', (code, message) => {
    expect(captureError(code)).toMatchObject({ code, message });
  });

  it('never serializes an empty message', () => {
    for (const code of CAPTURE_ERROR_CODES) {
      expect(captureError(code).message.trim()).not.toBe('');
    }
  });

  it('assigns explicit recovery behavior', () => {
    expect(captureError('USER_PLAY_REQUIRED').recovery).toBe('user-play');
    expect(captureError('TAB_FROZEN').recovery).toBe('bring-forward');
    expect(captureError('TARGET_NAVIGATED').recovery).toBe('re-arm');
    expect(captureError('TAB_CLOSED').recovery).toBe('re-arm');
    expect(captureError('STREAM_ID_EXPIRED').recovery).toBe('restart');
  });

  it('normalizes only supported legacy transcription codes', () => {
    expect(normalizeCaptureErrorCode('transcription-cancelled')).toBe('TRANSCRIPTION_CANCELLED');
    expect(normalizeCaptureErrorCode('transcription-timeout')).toBe('TRANSCRIPTION_TIMEOUT');
    expect(normalizeCaptureErrorCode('remote-api-failed')).toBeUndefined();
  });

  it('does not permit detail text to replace stable user-facing copy', () => {
    expect(captureError('CAPTURE_DENIED', 'raw browser exception')).toEqual({
      code: 'CAPTURE_DENIED',
      detail: 'raw browser exception',
      message: 'Chrome did not grant access to this tab audio.',
      recovery: 'retry',
      severity: 'error'
    });
  });
});
