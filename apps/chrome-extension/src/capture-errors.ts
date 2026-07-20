export const CAPTURE_ERROR_CODES = Object.freeze([
  'NEEDS_USER_ARMING',
  'TAB_NOT_ARMED',
  'NO_PLAYABLE_MEDIA',
  'USER_PLAY_REQUIRED',
  'EMBEDDED_PLAYER_CLICK_REQUIRED',
  'CROSS_ORIGIN_PLAYER',
  'TAB_FROZEN',
  'TARGET_NAVIGATED',
  'CAPTURE_DENIED',
  'STREAM_ID_EXPIRED',
  'STREAM_ENDED',
  'TAB_CLOSED',
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
  'DEBUGGER_ATTACH_FAILED',
  'DEBUGGER_DETACHED',
  'NO_AUDIO_AFTER_TIMEOUT',
  'TRANSCRIPTION_CANCELLED',
  'TRANSCRIPTION_TIMEOUT',
  'TRANSCRIPTION_DEADLINE_EXCEEDED',
  'ACCELERATED_SOURCE_UNAVAILABLE'
] as const);

export type CaptureErrorCode = typeof CAPTURE_ERROR_CODES[number];
export type CaptureRecovery = 'retry' | 'user-play' | 'bring-forward' | 're-arm' | 'restart';

export type CaptureFailure = Readonly<{
  code: CaptureErrorCode;
  detail?: string;
  message: string;
  recovery: CaptureRecovery;
  severity: 'warning' | 'error';
}>;

type CaptureErrorDefinition = Omit<CaptureFailure, 'code' | 'detail'>;

const DEFINITIONS: Readonly<Record<CaptureErrorCode, CaptureErrorDefinition>> = Object.freeze({
  NEEDS_USER_ARMING: definition('Click Voice VAC on the target tab before starting transcription.', 'warning', 're-arm'),
  TAB_NOT_ARMED: definition('Click the Voice VAC extension on this tab to arm it.', 'warning', 're-arm'),
  NO_PLAYABLE_MEDIA: definition('No playable video found here.', 'warning', 'retry'),
  USER_PLAY_REQUIRED: definition('Press play once in Chrome.', 'warning', 'user-play'),
  EMBEDDED_PLAYER_CLICK_REQUIRED: definition('This embedded player needs one click to start.', 'warning', 'user-play'),
  CROSS_ORIGIN_PLAYER: definition('This embedded player must be started once in Chrome.', 'warning', 'user-play'),
  TAB_FROZEN: definition('This tab is asleep. Bring it forward to continue.', 'warning', 'bring-forward'),
  TARGET_NAVIGATED: definition('The page changed. Arm this tab again.', 'warning', 're-arm'),
  CAPTURE_DENIED: definition('Chrome did not grant access to this tab audio.', 'error', 'retry'),
  STREAM_ID_EXPIRED: definition('The tab audio authorization expired. Start again.', 'warning', 'restart'),
  STREAM_ENDED: definition('The tab audio stream ended. Start again.', 'warning', 'restart'),
  TAB_CLOSED: definition('The armed Chrome tab was closed.', 'warning', 're-arm'),
  NATIVE_HOST_UNAVAILABLE: definition('Open the Voice VAC app, then try again.', 'error', 'retry'),
  EXTENSION_UNAVAILABLE: definition('The Voice VAC Chrome extension is unavailable.', 'error', 'retry'),
  COMMAND_ACK_TIMEOUT: definition('The Voice VAC extension did not acknowledge the command in time.', 'error', 'retry'),
  ASR_RUNTIME_MISSING: definition('The local Voice VAC speech runtime is not installed.', 'error', 'restart'),
  ASR_MODEL_MISSING: definition('The local Qwen3-ASR model is not installed.', 'error', 'restart'),
  ASR_MODEL_LOAD_FAILED: definition('Voice VAC could not load the local Qwen3-ASR model.', 'error', 'restart'),
  ASR_STARTUP_TIMEOUT: definition('The local speech model did not become ready in time.', 'error', 'retry'),
  ASR_INFERENCE_TIMEOUT: definition('Local speech recognition did not finish in time.', 'error', 'retry'),
  ASR_INFERENCE_FAILED: definition('Local speech recognition failed.', 'error', 'retry'),
  AUDIO_SEQUENCE_MISMATCH: definition('The private audio stream arrived out of order.', 'error', 'restart'),
  AUDIO_RELAY_BACKPRESSURE: definition('The private audio relay could not keep up.', 'error', 'restart'),
  DEBUGGER_ATTACH_FAILED: definition('Chrome could not attach Voice VAC automation.', 'error', 'retry'),
  DEBUGGER_DETACHED: definition('Chrome detached Voice VAC automation. Start again.', 'warning', 'restart'),
  NO_AUDIO_AFTER_TIMEOUT: definition('No audio arrived. Make sure the video is playing.', 'warning', 'user-play'),
  TRANSCRIPTION_CANCELLED: definition('The transcription was cancelled.', 'warning', 'restart'),
  TRANSCRIPTION_TIMEOUT: definition('Local transcription did not finish in time.', 'error', 'retry'),
  TRANSCRIPTION_DEADLINE_EXCEEDED: definition('The transcription exceeded its overall deadline.', 'error', 'retry'),
  ACCELERATED_SOURCE_UNAVAILABLE: definition('Accelerated mode is unavailable for this media source.', 'warning', 'retry')
});

const LEGACY_CODES: Readonly<Record<string, CaptureErrorCode>> = Object.freeze({
  'transcription-cancelled': 'TRANSCRIPTION_CANCELLED',
  'transcription-timeout': 'TRANSCRIPTION_TIMEOUT'
});

const CODE_SET: ReadonlySet<string> = new Set(CAPTURE_ERROR_CODES);

export function captureError(code: CaptureErrorCode, detail?: string): CaptureFailure {
  const failure: CaptureFailure = {
    code,
    ...DEFINITIONS[code],
    ...(detail?.trim() ? { detail } : {})
  };
  return Object.freeze(failure);
}

export function normalizeCaptureErrorCode(value: unknown): CaptureErrorCode | undefined {
  if (typeof value !== 'string') return undefined;
  if (CODE_SET.has(value)) return value as CaptureErrorCode;
  return LEGACY_CODES[value];
}

function definition(
  message: string,
  severity: CaptureErrorDefinition['severity'],
  recovery: CaptureRecovery
): CaptureErrorDefinition {
  return Object.freeze({ message, recovery, severity });
}
