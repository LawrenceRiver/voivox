import type {
  DesktopDiscovery,
  LocalAsrAvailability
} from './local-transcription.js';

export const VOIVOX_NATIVE_HOST = 'com.voivox.bridge';

export type NativeMessenger = (
  host: string,
  message: Record<string, unknown>
) => Promise<unknown>;

export type NativeDiscoveryOptions = {
  sendMessage?: NativeMessenger;
  timeoutMs?: number;
};

export async function discoverNativeDesktop({
  sendMessage = sendNativeMessage,
  timeoutMs = 750
}: NativeDiscoveryOptions = {}): Promise<DesktopDiscovery> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      sendMessage(VOIVOX_NATIVE_HOST, { protocolVersion: 1, type: 'discover' }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Voice Vac native host timed out.')), timeoutMs);
      })
    ]);
    const connection = parseNativeConnection(response);
    return connection ?? { reachable: false, source: 'none' };
  } catch {
    return { reachable: false, source: 'none' };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function parseNativeConnection(value: unknown): DesktopDiscovery | undefined {
  if (
    !isRecord(value)
    || value.protocolVersion !== 1
    || value.service !== 'voivox'
    || value.status !== 'ready'
    || !isRecord(value.capabilities)
    || !isLocalAsrAvailability(value.capabilities.localAsr)
    || typeof value.token !== 'string'
    || value.token.length === 0
    || value.token.length > 16_384
  ) {
    return undefined;
  }
  const baseUrl = normalizeLoopbackBaseUrl(value.baseUrl);
  if (!baseUrl) {
    return undefined;
  }

  return {
    baseUrl,
    localAsr: value.capabilities.localAsr,
    reachable: true,
    source: 'native-messaging',
    token: value.token
  };
}

function normalizeLoopbackBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (
      url.protocol !== 'http:'
      || url.hostname !== '127.0.0.1'
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
    ) {
      return undefined;
    }
    return `http://127.0.0.1:${port}`;
  } catch {
    return undefined;
  }
}

function sendNativeMessage(host: string, message: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(host, message, (response: unknown) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLocalAsrAvailability(value: unknown): value is LocalAsrAvailability {
  return value === 'checking' || value === 'ready' || value === 'missing';
}
