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
      documentId: 'doc-11',
      dropToken: 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      frameId: 0,
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
    expect(JSON.parse(String((calls[0]?.init as RequestInit).body))).toMatchObject({
      tabId: 11,
      frameId: 0,
      documentId: 'doc-11',
      dropToken: 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    });

    await syncTunnelSession({
      discovery,
      documentId: 'retargeted',
      dropToken: 'retargeted',
      errorCode: 'TARGET_NAVIGATED',
      frameId: 9,
      sessionId: id,
      state: 'transcribing',
      tabId: 99
    }, request);
    expect(calls[1]?.input).toContain('/voice-vac-session-1');
    expect((calls[1]?.init as RequestInit).method).toBe('PATCH');
    const patch = JSON.parse(String((calls[1]?.init as RequestInit).body));
    expect(patch).toEqual({ errorCode: 'TARGET_NAVIGATED', state: 'transcribing' });
    expect(patch).not.toHaveProperty('tabId');
    expect(patch).not.toHaveProperty('frameId');
    expect(patch).not.toHaveProperty('documentId');
    expect(patch).not.toHaveProperty('dropToken');
  });

  it('remains optional when no native desktop bridge is available', async () => {
    await expect(syncTunnelSession({
      discovery: { reachable: false, source: 'none' },
      tabId: 1,
      frameId: 0,
      documentId: 'doc-1',
      dropToken: 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    })).resolves.toBeUndefined();
  });
});
