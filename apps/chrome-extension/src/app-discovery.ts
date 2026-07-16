import type { DesktopDiscovery, LocalAsrAvailability } from './local-transcription.js';

export const VOIVOX_DISCOVERY_BASE_URL = 'http://127.0.0.1:43817';

export type DesktopAppDiscovery = DesktopDiscovery;

export type DesktopDiscoveryOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

type HealthResponse = {
  capabilities: {
    extensionDiscovery: boolean;
    localAsr: LocalAsrAvailability;
  };
  service: 'voivox';
  status: 'ready';
  version: string;
};

export async function discoverDesktopApp({
  fetcher = fetch,
  timeoutMs = 750
}: DesktopDiscoveryOptions = {}): Promise<DesktopAppDiscovery> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const healthResponse = await fetcher(`${VOIVOX_DISCOVERY_BASE_URL}/health`, {
      cache: 'no-store',
      signal: controller.signal
    });
    const health = await readHealthResponse(healthResponse);
    const discovered: DesktopAppDiscovery = {
      extensionDiscovery: health.capabilities.extensionDiscovery,
      localAsr: health.capabilities.localAsr,
      reachable: true,
      source: 'loopback-probe'
    };

    return discovered;
  } catch {
    return { reachable: false, source: 'none' };
  } finally {
    clearTimeout(timeout);
  }
}

async function readHealthResponse(response: Response): Promise<HealthResponse> {
  if (!response.ok) {
    throw new Error('VOIVOX desktop health check failed.');
  }
  const body = await response.json() as unknown;
  if (
    !isRecord(body)
    || body.service !== 'voivox'
    || body.status !== 'ready'
    || typeof body.version !== 'string'
    || !isRecord(body.capabilities)
    || typeof body.capabilities.extensionDiscovery !== 'boolean'
    || !isLocalAsrAvailability(body.capabilities.localAsr)
  ) {
    throw new Error('VOIVOX desktop health response was invalid.');
  }
  return body as HealthResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLocalAsrAvailability(value: unknown): value is LocalAsrAvailability {
  return value === 'checking' || value === 'ready' || value === 'missing';
}
