import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  discoverNativeDesktop,
  VOIVOX_NATIVE_HOST,
  type NativeMessenger
} from '../src/native-discovery.js';

describe('discoverNativeDesktop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a trusted desktop connection only from the native messaging host', async () => {
    const sendMessage = vi.fn<NativeMessenger>().mockResolvedValue({
      baseUrl: 'http://127.0.0.1:49152',
      capabilities: { localAsr: 'ready' },
      protocolVersion: 1,
      service: 'voivox',
      status: 'ready',
      token: 'restricted-extension-token'
    });

    await expect(discoverNativeDesktop({ sendMessage })).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:49152',
      localAsr: 'ready',
      reachable: true,
      source: 'native-messaging',
      token: 'restricted-extension-token'
    });
    expect(sendMessage).toHaveBeenCalledWith(VOIVOX_NATIVE_HOST, {
      protocolVersion: 1,
      type: 'discover'
    });
  });

  it.each([
    'https://127.0.0.1:49152',
    'http://localhost:49152',
    'http://127.0.0.1:49152/untrusted-path',
    'http://127.0.0.1:49152?token=leak',
    'http://user@127.0.0.1:49152'
  ])('rejects a native response with a non-exact loopback base URL: %s', async (baseUrl) => {
    const sendMessage = vi.fn<NativeMessenger>().mockResolvedValue({
      baseUrl,
      capabilities: { localAsr: 'ready' },
      protocolVersion: 1,
      service: 'voivox',
      status: 'ready',
      token: 'restricted-extension-token'
    });

    await expect(discoverNativeDesktop({ sendMessage })).resolves.toEqual({
      reachable: false,
      source: 'none'
    });
  });

  it('falls back when the native host is missing, refuses, or returns malformed data', async () => {
    const missing = vi.fn<NativeMessenger>().mockRejectedValue(new Error('Specified native messaging host not found.'));
    const malformed = vi.fn<NativeMessenger>().mockResolvedValue({ status: 'ready' });

    await expect(discoverNativeDesktop({ sendMessage: missing })).resolves.toEqual({ reachable: false, source: 'none' });
    await expect(discoverNativeDesktop({ sendMessage: malformed })).resolves.toEqual({ reachable: false, source: 'none' });
  });

  it('times out a native host that never replies', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn<NativeMessenger>(() => new Promise(() => undefined));

    const discovery = discoverNativeDesktop({ sendMessage, timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(30);

    await expect(discovery).resolves.toEqual({ reachable: false, source: 'none' });
  });
});
