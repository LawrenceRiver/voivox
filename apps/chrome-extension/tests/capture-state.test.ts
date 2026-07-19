import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeCaptureState, saveCaptureState } from '../src/bridge.js';

afterEach(() => vi.unstubAllGlobals());

describe('normalizeCaptureState', () => {
  it('returns a quality-mode idle state for a first installation', () => {
    expect(normalizeCaptureState(undefined)).toEqual({
      active: false,
      mode: 'quality',
      phase: 'idle'
    });
  });

  it('migrates the previous active-only state without inventing a transcript', () => {
    expect(normalizeCaptureState({ active: true, tabTitle: 'Music video', tabUrl: 'https://example.com/video' })).toEqual({
      active: true,
      mode: 'quality',
      phase: 'capturing',
      tabTitle: 'Music video',
      tabUrl: 'https://example.com/video'
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

  it.each([
    'armed',
    'connecting',
    'awaiting-user-play',
    'capturing',
    'paused',
    'downloading',
    'transcribing',
    'complete',
    'error'
  ] as const)('preserves the %s target-session capture phase', (phase) => {
    expect(normalizeCaptureState({ active: phase === 'capturing', mode: 'quality', phase }).phase)
      .toBe(phase);
  });

  it('never persists a tab identity in compatibility capture state', () => {
    expect(normalizeCaptureState({
      active: false,
      mode: 'quality',
      phase: 'armed',
      tabId: 41,
      documentId: 'doc-41'
    })).not.toMatchObject({ tabId: 41, documentId: 'doc-41' });
  });

  it('strips runtime-injected tab identity at the storage write boundary', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', { storage: { local: { set } } });

    await saveCaptureState({
      active: false,
      mode: 'quality',
      phase: 'armed',
      tabId: 41,
      documentId: 'doc-41'
    } as never);

    expect(set).toHaveBeenCalledWith({
      voivoxCaptureState: { active: false, mode: 'quality', phase: 'armed' }
    });
  });

  it('normalizes an explicitly invalid phase to idle even when legacy active is true', () => {
    expect(normalizeCaptureState({ active: true, mode: 'quality', phase: 'alien' })).toMatchObject({
      active: true,
      phase: 'idle'
    });
  });

  it('normalizes legacy transcription codes and preserves only known capture errors', () => {
    expect(normalizeCaptureState({
      active: false,
      canRetry: true,
      errorCode: 'TRANSCRIPTION_TIMEOUT',
      mode: 'quality',
      phase: 'error',
      route: 'browser-local'
    })).toMatchObject({
      canRetry: true,
      errorCode: 'TRANSCRIPTION_TIMEOUT',
      phase: 'error'
    });

    expect(normalizeCaptureState({
      active: false,
      errorCode: 'USER_PLAY_REQUIRED',
      mode: 'quality',
      phase: 'awaiting-user-play'
    })).toMatchObject({
      errorCode: 'USER_PLAY_REQUIRED',
      phase: 'awaiting-user-play'
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
