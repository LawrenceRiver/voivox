import type { DesktopDiscovery } from './local-transcription.js';
import type { TunnelPoint, TunnelRect, TunnelLinkState } from './bridge.js';

export type TunnelSessionSyncInput = {
  discovery: DesktopDiscovery;
  tabId: number;
  state?: TunnelLinkState;
  title?: string;
  url?: string;
  targetRect?: TunnelRect;
  pageEndpoint?: TunnelPoint;
  sessionId?: string;
};

export async function syncTunnelSession(
  input: TunnelSessionSyncInput,
  request: typeof fetch = fetch
): Promise<string | undefined> {
  if (input.discovery.source !== 'native-messaging' || !input.discovery.reachable) return undefined;
  const body = {
    ...(input.sessionId ? {} : { tabId: input.tabId }),
    ...(input.state ? { state: input.state } : {}),
    ...(input.title ? { title: input.title.slice(0, 500) } : {}),
    ...(input.url && /^https?:\/\//u.test(input.url) ? { url: input.url.slice(0, 4_000) } : {}),
    ...(input.targetRect ? { targetRect: input.targetRect } : {}),
    ...(input.pageEndpoint ? { pageEndpoint: input.pageEndpoint } : {})
  };
  const endpoint = input.sessionId
    ? `${input.discovery.baseUrl}/v1/extension/tunnel-sessions/${encodeURIComponent(input.sessionId)}`
    : `${input.discovery.baseUrl}/v1/extension/tunnel-sessions`;
  try {
    const response = await request(endpoint, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${input.discovery.token}`,
        'content-type': 'application/json'
      },
      method: input.sessionId ? 'PATCH' : 'POST'
    });
    if (!response.ok) return undefined;
    const result = await response.json() as { id?: unknown };
    return typeof result.id === 'string' ? result.id : input.sessionId;
  } catch {
    return undefined;
  }
}
