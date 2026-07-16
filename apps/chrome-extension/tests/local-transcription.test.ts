import { describe, expect, it } from 'vitest';

import {
  browserModelForMode,
  chooseTranscriptionRoute,
  type DesktopDiscovery
} from '../src/local-transcription.js';

describe('browser-local transcription models', () => {
  it('pins the multilingual quality model and quantization', () => {
    expect(browserModelForMode('quality')).toEqual({
      approximateDownloadMb: 80,
      dtype: 'q8',
      id: 'onnx-community/whisper-base',
      revision: '1846881b6b3a3024392c1eea3ad983695bc23925'
    });
  });

  it('pins the smaller fast model and quantization', () => {
    expect(browserModelForMode('fast')).toEqual({
      approximateDownloadMb: 45,
      dtype: 'q8',
      id: 'onnx-community/whisper-tiny',
      revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7'
    });
  });
});

describe('transcription route selection', () => {
  const readyDesktop: DesktopDiscovery = {
    reachable: true,
    localAsr: 'ready'
  };

  it('prefers a reachable desktop only when its local ASR is ready', () => {
    expect(chooseTranscriptionRoute(readyDesktop, true)).toBe('desktop-local');
    expect(chooseTranscriptionRoute({ reachable: true, localAsr: 'missing' }, true)).toBe('browser-local');
    expect(chooseTranscriptionRoute({ reachable: true, localAsr: 'checking' }, true)).toBe('browser-local');
  });

  it('works without the desktop app', () => {
    expect(chooseTranscriptionRoute({ reachable: false }, true)).toBe('browser-local');
  });

  it('reports an honest unavailable state when neither local route can run', () => {
    expect(chooseTranscriptionRoute({ reachable: false }, false)).toBe('unavailable');
    expect(chooseTranscriptionRoute({ reachable: true, localAsr: 'missing' }, false)).toBe('unavailable');
  });
});
