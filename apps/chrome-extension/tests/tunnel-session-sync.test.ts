import { describe, expect, it } from 'vitest';

import { syncTunnelSession } from '../src/tunnel-session-sync.js';

describe('browser tunnel session sync', () => {
  it('registers and patches the same session through the restricted bridge', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const request: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({ id: 'voice-vac-session-1' }), { status: 201 });
    };
    const discovery = { baseUrl: 'http://127.0.0.1:43817', localAsr: 'ready' as const, reachable: true as const, source: 'native-messaging' as const, token: 'bridge-token' };
    const id = await syncTunnelSession({
      discovery,
      pageEndpoint: { screenX: 400, screenY: 88 },
      state: 'ready',
      tabId: 11,
      targetRect: { x: 20, y: 30, width: 640, height: 360 },
      title: 'Demo',
      url: 'https://example.com/demo'
    }, request);
    expect(id).toBe('voice-vac-session-1');
    expect(calls[0]?.input).toBe('http://127.0.0.1:43817/v1/extension/tunnel-sessions');
    expect((calls[0]?.init as RequestInit).method).toBe('POST');

    await syncTunnelSession({ discovery, sessionId: id, state: 'transcribing', tabId: 11 }, request);
    expect(calls[1]?.input).toContain('/voice-vac-session-1');
    expect((calls[1]?.init as RequestInit).method).toBe('PATCH');
  });

  it('remains optional when no native desktop bridge is available', async () => {
    await expect(syncTunnelSession({ discovery: { reachable: false, source: 'none' }, tabId: 1 })).resolves.toBeUndefined();
  });
});
