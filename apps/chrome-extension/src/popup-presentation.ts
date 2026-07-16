import type { MessageKey } from '@voivox/i18n';

import type { CaptureState } from './bridge.js';

export function isProcessingPhase(phase: CaptureState['phase']): boolean {
  return phase === 'downloading' || phase === 'transcribing';
}

export function captureActionKey(state: CaptureState): MessageKey {
  if (isProcessingPhase(state.phase)) {
    return 'capture.cancelTranscription';
  }
  return state.active ? 'capture.stopAndTranscribe' : 'capture.startCurrentTab';
}
