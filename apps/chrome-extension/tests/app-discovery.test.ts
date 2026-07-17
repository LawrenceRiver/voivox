import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  discoverDesktopApp,
  VOIVOX_DISCOVERY_BASE_URL
} from '../src/app-discovery.js';

describe('discoverDesktopApp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats fixed-port readiness as an unauthenticated status probe only', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      capabilities: { extensionDiscovery: true, localAsr: 'ready' },
      service: 'voivox',
      status: 'ready',
      version: '0.1.1'
    }));

    const result = await discoverDesktopApp({ fetcher });

    expect(fetcher.mock.calls[0]?.[0]).toBe(`${VOIVOX_DISCOVERY_BASE_URL}/health`);
    expect(result).toEqual({
      extensionDiscovery: true,
      localAsr: 'ready',
      reachable: true,
      source: 'loopback-probe'
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['checking', 'missing'] as const)(
    'reports a reachable App with ASR %s without requesting a token',
    async (localAsr) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
        capabilities: { extensionDiscovery: true, localAsr },
        service: 'voivox',
        status: 'ready',
        version: '0.1.1'
      }));

      await expect(discoverDesktopApp({ fetcher })).resolves.toEqual({
        extensionDiscovery: true,
        localAsr,
        reachable: true,
        source: 'loopback-probe'
      });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  );

  it('does not bootstrap when the App had to abandon the discovery port', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      capabilities: { extensionDiscovery: false, localAsr: 'ready' },
      service: 'voivox',
      status: 'ready',
      version: '0.1.1'
    }));

    await expect(discoverDesktopApp({ fetcher })).resolves.toEqual({
      extensionDiscovery: false,
      localAsr: 'ready',
      reachable: true,
      source: 'loopback-probe'
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('falls back safely for malformed or failed responses', async () => {
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: 'ready' }));
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection refused'));

    await expect(discoverDesktopApp({ fetcher: malformed })).resolves.toEqual({ reachable: false, source: 'none' });
    await expect(discoverDesktopApp({ fetcher: failed })).resolves.toEqual({ reachable: false, source: 'none' });
  });

  it('times out a stalled App probe', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const discovery = discoverDesktopApp({ fetcher, timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(discovery).resolves.toEqual({ reachable: false, source: 'none' });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status
  });
}
