export const VOICE_VAC_ERROR_CODES = Object.freeze([
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
] as const);

export type VoiceVacErrorCode = typeof VOICE_VAC_ERROR_CODES[number];

type ErrorDefinition = Readonly<{
  httpStatus: number;
  message: string;
  retryable: boolean;
}>;

const ERROR_DEFINITIONS: Readonly<Record<VoiceVacErrorCode, ErrorDefinition>> = Object.freeze({
  NEEDS_USER_ARMING: definition(409, true, 'Click Voice VAC on the target tab before starting transcription.'),
  TAB_NOT_ARMED: definition(409, true, 'The selected Chrome tab is not armed.'),
  TARGET_NAVIGATED: definition(409, true, 'The armed page navigated. Arm the current page again.'),
  TAB_CLOSED: definition(410, true, 'The armed Chrome tab was closed.'),
  CAPTURE_DENIED: definition(403, true, 'Chrome did not grant access to the selected tab audio.'),
  STREAM_ID_EXPIRED: definition(409, true, 'The selected tab audio authorization expired.'),
  STREAM_ENDED: definition(409, true, 'The selected tab audio stream ended.'),
  NATIVE_HOST_UNAVAILABLE: definition(503, true, 'The Voice VAC native bridge is unavailable.'),
  EXTENSION_UNAVAILABLE: definition(503, true, 'The Voice VAC Chrome extension is unavailable.'),
  COMMAND_ACK_TIMEOUT: definition(504, true, 'The Voice VAC extension did not acknowledge the command in time.'),
  ASR_RUNTIME_MISSING: definition(503, false, 'The local Voice VAC speech runtime is not installed.'),
  ASR_MODEL_MISSING: definition(503, false, 'The local Qwen3-ASR model is not installed.'),
  ASR_MODEL_LOAD_FAILED: definition(503, false, 'Voice VAC could not load the local Qwen3-ASR model.'),
  ASR_STARTUP_TIMEOUT: definition(504, true, 'The local speech model did not become ready in time.'),
  ASR_INFERENCE_TIMEOUT: definition(504, true, 'Local speech recognition did not finish in time.'),
  ASR_INFERENCE_FAILED: definition(500, true, 'Local speech recognition failed.'),
  AUDIO_SEQUENCE_MISMATCH: definition(409, true, 'The private audio stream arrived out of order.'),
  AUDIO_RELAY_BACKPRESSURE: definition(429, true, 'The private audio relay could not keep up.'),
  NO_AUDIO_AFTER_TIMEOUT: definition(408, true, 'No audio arrived from the selected tab.'),
  TRANSCRIPTION_CANCELLED: definition(409, false, 'The transcription was cancelled.'),
  TRANSCRIPTION_DEADLINE_EXCEEDED: definition(504, true, 'The transcription exceeded its overall deadline.'),
  ACCELERATED_SOURCE_UNAVAILABLE: definition(422, false, 'Accelerated mode is unavailable for this media source.')
});

export type VoiceVacErrorBody = Readonly<{
  code: VoiceVacErrorCode | 'INTERNAL_ERROR';
  error: string;
  retryable: boolean;
}>;

export type SerializedVoiceVacError = Readonly<{
  body: VoiceVacErrorBody;
  statusCode: number;
}>;

export class VoiceVacError extends Error {
  readonly code: VoiceVacErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    code: VoiceVacErrorCode,
    message = ERROR_DEFINITIONS[code].message,
    retryable = ERROR_DEFINITIONS[code].retryable,
    httpStatus = ERROR_DEFINITIONS[code].httpStatus,
    cause?: unknown
  ) {
    super(message, { cause });
    const expected = ERROR_DEFINITIONS[code];
    if (retryable !== expected.retryable || httpStatus !== expected.httpStatus) {
      throw new TypeError(`Voice VAC error policy for ${code} is fixed.`);
    }
    this.name = 'VoiceVacError';
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    Object.defineProperties(this, {
      code: { configurable: false, enumerable: true, value: code, writable: false },
      retryable: { configurable: false, enumerable: true, value: retryable, writable: false },
      httpStatus: { configurable: false, enumerable: true, value: httpStatus, writable: false }
    });
  }
}

export function isVoiceVacError(error: unknown): error is VoiceVacError {
  return error instanceof VoiceVacError;
}

export function serializeVoiceVacError(error: unknown): SerializedVoiceVacError {
  if (
    isVoiceVacError(error)
    && Object.prototype.hasOwnProperty.call(ERROR_DEFINITIONS, error.code)
  ) {
    const definition = ERROR_DEFINITIONS[error.code];
    return {
      statusCode: definition.httpStatus,
      body: {
        code: error.code,
        error: definition.message,
        retryable: definition.retryable
      }
    };
  }

  return {
    statusCode: 500,
    body: {
      code: 'INTERNAL_ERROR',
      error: 'Voice VAC could not complete the request.',
      retryable: false
    }
  };
}

function definition(httpStatus: number, retryable: boolean, message: string): ErrorDefinition {
  return Object.freeze({ httpStatus, message, retryable });
}
