import { describe, expect, it } from 'vitest';

import {
  chooseTranscriptionRoute,
  type DesktopDiscovery
} from '../src/local-transcription.js';

describe('transcription route selection', () => {
  const readyDesktop: DesktopDiscovery = {
    baseUrl: 'http://127.0.0.1:43817',
    reachable: true,
    localAsr: 'ready',
    source: 'native-messaging',
    token: 'extension-only-token'
  };

  it('uses only an authenticated native-messaging desktop with a ready or checking local ASR', () => {
    expect(chooseTranscriptionRoute(readyDesktop)).toBe('desktop-local');
    expect(chooseTranscriptionRoute({
      baseUrl: 'http://127.0.0.1:43817',
      reachable: true,
      localAsr: 'checking',
      source: 'native-messaging',
      token: 'token'
    })).toBe('desktop-local');
  });

  it('is unavailable without the authenticated desktop bridge', () => {
    expect(chooseTranscriptionRoute({ reachable: false, source: 'none' })).toBe('unavailable');
  });

  it('is unavailable when the desktop reports the model missing', () => {
    expect(chooseTranscriptionRoute({
      baseUrl: 'http://127.0.0.1:43817',
      reachable: true,
      localAsr: 'missing',
      source: 'native-messaging',
      token: 'token'
    })).toBe('unavailable');
  });

  it('does not use a desktop that had to abandon the discovery port', () => {
    expect(chooseTranscriptionRoute({
      extensionDiscovery: false,
      localAsr: 'ready',
      reachable: true,
      source: 'loopback-probe'
    })).toBe('unavailable');
  });

  it('rejects a native message that points outside exact IPv4 loopback', () => {
    expect(chooseTranscriptionRoute({
      baseUrl: 'https://example.com',
      localAsr: 'ready',
      reachable: true,
      source: 'native-messaging',
      token: 'restricted-token'
    })).toBe('unavailable');
  });
});
