import type { MessageKey } from '@voivox/i18n';

import type { CaptureState } from './bridge.js';

export function isProcessingPhase(phase: CaptureState['phase']): boolean {
  return phase === 'downloading' || phase === 'transcribing';
}

export type CaptureCommandType =
  | 'capture-start'
  | 'capture-pause'
  | 'capture-resume'
  | 'capture-stop';

export function captureCommandForState(state: CaptureState): CaptureCommandType {
  if (state.phase === 'capturing') return 'capture-pause';
  if (state.phase === 'paused') return 'capture-resume';
  if (state.phase === 'transcribing' || state.phase === 'downloading') return 'capture-stop';
  return 'capture-start';
}

export function captureActionKey(state: CaptureState): MessageKey {
  switch (captureCommandForState(state)) {
    case 'capture-pause': return 'capture.pause';
    case 'capture-resume': return 'capture.resume';
    case 'capture-stop': return 'capture.cancelTranscription';
    case 'capture-start': return 'capture.startCurrentTab';
  }
}

export function captureGlyphForState(state: CaptureState): '▶' | 'Ⅱ' | '■' {
  switch (captureCommandForState(state)) {
    case 'capture-pause': return 'Ⅱ';
    case 'capture-stop': return '■';
    case 'capture-resume':
    case 'capture-start': return '▶';
  }
}
