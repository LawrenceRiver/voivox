export type TranscriptionMode = 'fast' | 'quality';

export type LocalAsrAvailability = 'checking' | 'ready' | 'missing';

export type DesktopDiscovery =
  | { reachable: false; source: 'none' }
  | {
      extensionDiscovery: boolean;
      localAsr: LocalAsrAvailability;
      reachable: true;
      source: 'loopback-probe';
    }
  | {
      baseUrl: string;
      localAsr: LocalAsrAvailability;
      reachable: true;
      source: 'native-messaging';
      token: string;
    };

export type TranscriptionRoute = 'desktop-local' | 'unavailable';

export function chooseTranscriptionRoute(
  desktop: DesktopDiscovery
): TranscriptionRoute {
  if (
    desktop.source !== 'native-messaging'
    || desktop.reachable !== true
    || (desktop.localAsr !== 'checking' && desktop.localAsr !== 'ready')
    || !isExactIpv4LoopbackBaseUrl(desktop.baseUrl)
    || !desktop.token
  ) {
    return 'unavailable';
  }
  return 'desktop-local';
}

function isExactIpv4LoopbackBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535
      && url.pathname === '/'
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}
