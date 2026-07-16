import { describe, expect, it } from 'vitest';

import { normalizeCaptureState } from '../src/bridge.js';

describe('normalizeCaptureState', () => {
  it('returns a quality-mode idle state for a first installation', () => {
    expect(normalizeCaptureState(undefined)).toEqual({
      active: false,
      mode: 'quality',
      phase: 'idle'
    });
  });

  it('migrates the previous active-only state without inventing a transcript', () => {
    expect(normalizeCaptureState({ active: true, tabTitle: 'Music video' })).toEqual({
      active: true,
      mode: 'quality',
      phase: 'capturing',
      tabTitle: 'Music video'
    });
  });

  it('preserves a valid completed browser-local transcript', () => {
    expect(normalizeCaptureState({
      active: false,
      mode: 'fast',
      phase: 'complete',
      route: 'browser-local',
      tabTitle: 'MV',
      transcript: '歌词转写'
    })).toEqual({
      active: false,
      mode: 'fast',
      phase: 'complete',
      route: 'browser-local',
      tabTitle: 'MV',
      transcript: '歌词转写'
    });
  });

  it('preserves only known localized transcription error codes', () => {
    expect(normalizeCaptureState({
      active: false,
      canRetry: true,
      errorCode: 'transcription-timeout',
      mode: 'quality',
      phase: 'error',
      route: 'browser-local'
    })).toMatchObject({
      canRetry: true,
      errorCode: 'transcription-timeout',
      phase: 'error'
    });

    expect(normalizeCaptureState({
      active: false,
      errorCode: 'remote-api-failed',
      mode: 'quality',
      phase: 'error'
    })).not.toHaveProperty('errorCode');
  });

  it('drops invalid progress, route, and error fields', () => {
    expect(normalizeCaptureState({
      active: false,
      error: 42,
      mode: 'cloud',
      phase: 'downloading',
      progress: 140,
      route: 'api'
    })).toEqual({
      active: false,
      mode: 'quality',
      phase: 'downloading'
    });
  });
});
