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
    baseUrl: 'http://127.0.0.1:43817',
    reachable: true,
    localAsr: 'ready',
    source: 'native-messaging',
    token: 'extension-only-token'
  };

  it('keeps Chrome audio browser-local regardless of desktop ASR readiness', () => {
    expect(chooseTranscriptionRoute(readyDesktop, true)).toBe('browser-local');
    expect(chooseTranscriptionRoute({ baseUrl: 'http://127.0.0.1:43817', reachable: true, localAsr: 'missing', source: 'native-messaging', token: 'token' }, true)).toBe('browser-local');
    expect(chooseTranscriptionRoute({ baseUrl: 'http://127.0.0.1:43817', reachable: true, localAsr: 'checking', source: 'native-messaging', token: 'token' }, true)).toBe('browser-local');
  });

  it('works without the desktop app', () => {
    expect(chooseTranscriptionRoute({ reachable: false, source: 'none' }, true)).toBe('browser-local');
  });

  it('reports an honest unavailable state when neither local route can run', () => {
    expect(chooseTranscriptionRoute({ reachable: false, source: 'none' }, false)).toBe('unavailable');
    expect(chooseTranscriptionRoute({ extensionDiscovery: true, reachable: true, localAsr: 'missing', source: 'loopback-probe' }, false)).toBe('unavailable');
  });

  it('does not use a desktop that had to abandon the discovery port', () => {
    expect(chooseTranscriptionRoute({
      extensionDiscovery: false,
      localAsr: 'ready',
      reachable: true,
      source: 'loopback-probe'
    }, true)).toBe('browser-local');
  });

  it('uses an authenticated App connection only after browser-local transcription', () => {
    expect(chooseTranscriptionRoute({
      baseUrl: 'http://127.0.0.1:49152',
      localAsr: 'ready',
      reachable: true,
      source: 'native-messaging',
      token: 'restricted-token'
    }, true)).toBe('browser-local');
  });

  it('does not use a ready desktop until the native host returned a restricted token', () => {
    expect(chooseTranscriptionRoute({
      extensionDiscovery: true,
      localAsr: 'ready',
      reachable: true,
      source: 'loopback-probe'
    }, true)).toBe('browser-local');
  });

  it('does not trust a loopback server that only self-reports readiness', () => {
    expect(chooseTranscriptionRoute({
      extensionDiscovery: true,
      localAsr: 'ready',
      reachable: true,
      source: 'loopback-probe'
    }, true)).toBe('browser-local');
  });

  it('rejects a native message that points outside exact IPv4 loopback', () => {
    expect(chooseTranscriptionRoute({
      baseUrl: 'https://example.com',
      localAsr: 'ready',
      reachable: true,
      source: 'native-messaging',
      token: 'restricted-token'
    }, true)).toBe('browser-local');
  });
});
