import { describe, expect, it } from 'vitest';

import {
  isVoiceVacError,
  serializeVoiceVacError,
  VoiceVacError,
  VOICE_VAC_ERROR_CODES
} from '../src/voice-vac-error.js';

const expectedCodes = [
  'NEEDS_USER_ARMING',
  'TAB_NOT_ARMED',
  'TARGET_NAVIGATED',
  'TAB_CLOSED',
  'CAPTURE_DENIED',
  'STREAM_ID_EXPIRED',
  'STREAM_ENDED',
  'NATIVE_HOST_UNAVAILABLE',
  'EXTENSION_UNAVAILABLE',
  'COMMAND_ACK_TIMEOUT',
  'ASR_RUNTIME_MISSING',
  'ASR_MODEL_MISSING',
  'ASR_MODEL_LOAD_FAILED',
  'ASR_STARTUP_TIMEOUT',
  'ASR_INFERENCE_TIMEOUT',
  'ASR_INFERENCE_FAILED',
  'AUDIO_SEQUENCE_MISMATCH',
  'AUDIO_RELAY_BACKPRESSURE',
  'NO_AUDIO_AFTER_TIMEOUT',
  'TRANSCRIPTION_CANCELLED',
  'TRANSCRIPTION_DEADLINE_EXCEEDED',
  'ACCELERATED_SOURCE_UNAVAILABLE'
] as const;

describe('Voice VAC stable error contract', () => {
  it('publishes the complete immutable error-code vocabulary', () => {
    expect(VOICE_VAC_ERROR_CODES).toEqual(expectedCodes);
    expect(Object.isFrozen(VOICE_VAC_ERROR_CODES)).toBe(true);
  });

  it.each([
    ['NEEDS_USER_ARMING', 409, true],
    ['TAB_NOT_ARMED', 409, true],
    ['TARGET_NAVIGATED', 409, true],
    ['TAB_CLOSED', 410, true],
    ['CAPTURE_DENIED', 403, true],
    ['STREAM_ID_EXPIRED', 409, true],
    ['STREAM_ENDED', 409, true],
    ['NATIVE_HOST_UNAVAILABLE', 503, true],
    ['EXTENSION_UNAVAILABLE', 503, true],
    ['COMMAND_ACK_TIMEOUT', 504, true],
    ['ASR_RUNTIME_MISSING', 503, false],
    ['ASR_MODEL_MISSING', 503, false],
    ['ASR_MODEL_LOAD_FAILED', 503, false],
    ['ASR_STARTUP_TIMEOUT', 504, true],
    ['ASR_INFERENCE_TIMEOUT', 504, true],
    ['ASR_INFERENCE_FAILED', 500, true],
    ['AUDIO_SEQUENCE_MISMATCH', 409, true],
    ['AUDIO_RELAY_BACKPRESSURE', 429, true],
    ['NO_AUDIO_AFTER_TIMEOUT', 408, true],
    ['TRANSCRIPTION_CANCELLED', 409, false],
    ['TRANSCRIPTION_DEADLINE_EXCEEDED', 504, true],
    ['ACCELERATED_SOURCE_UNAVAILABLE', 422, false]
  ] as const)('serializes %s with a fixed status and retry policy', (code, statusCode, retryable) => {
    const cause = Object.assign(new Error('private bearer token'), {
      stderr: 'secret stderr',
      stdout: 'secret stdout'
    });
    const error = new VoiceVacError(
      code,
      `token=secret stderr=private stdout=private ${code}`,
      undefined,
      undefined,
      cause
    );

    expect(isVoiceVacError(error)).toBe(true);
    expect(error.cause).toBe(cause);
    const serializedError = serializeVoiceVacError(error);
    expect(serializedError).toEqual(serializeVoiceVacError(new VoiceVacError(code)));
    expect(serializedError.statusCode).toBe(statusCode);
    expect(serializedError.body).toMatchObject({ code, retryable });
    const serialized = JSON.stringify(serializeVoiceVacError(error));
    expect(serialized).not.toContain('token=secret');
    expect(serialized).not.toContain('stderr=private');
    expect(serialized).not.toContain('stdout=private');
    expect(serialized).not.toContain('private bearer token');
    expect(serialized).not.toContain('secret stderr');
    expect(serialized).not.toContain('secret stdout');
    expect(serialized).not.toContain('voice-vac-error.test.ts');
  });

  it('turns unknown failures into a generic non-retryable 500 response', () => {
    const unknown = Object.assign(new Error('token=do-not-leak'), {
      stderr: 'model path and stack',
      stdout: 'worker protocol bytes'
    });

    const serialized = serializeVoiceVacError(unknown);
    expect(serialized).toEqual({
      statusCode: 500,
      body: {
        code: 'INTERNAL_ERROR',
        error: 'Voice VAC could not complete the request.',
        retryable: false
      }
    });
    expect(JSON.stringify(serialized)).not.toMatch(/token|stderr|stdout|stack|model path/iu);
  });

  it('does not let a caller weaken the fixed status or retry policy', () => {
    expect(() => new VoiceVacError('CAPTURE_DENIED', 'Denied.', false, 200)).toThrow(
      'Voice VAC error policy for CAPTURE_DENIED is fixed.'
    );

    const error = new VoiceVacError('CAPTURE_DENIED');
    expect(() => Object.defineProperty(error, 'httpStatus', { value: 200 })).toThrow();
    expect(() => Object.defineProperty(error, 'retryable', { value: false })).toThrow();
    expect(() => Object.defineProperty(error, 'code', { value: 'TRANSCRIPTION_CANCELLED' })).toThrow();
    expect(serializeVoiceVacError(error)).toEqual({
      statusCode: 403,
      body: {
        code: 'CAPTURE_DENIED',
        error: 'Chrome did not grant access to the selected tab audio.',
        retryable: true
      }
    });
  });
});
