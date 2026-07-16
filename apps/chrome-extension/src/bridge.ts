export type BridgeConfig = {
  baseUrl: string;
  token: string;
};

export type CaptureState = {
  active: boolean;
  sessionId?: string;
  tabTitle?: string;
  error?: string;
};

const bridgeKey = 'voivoxBridge';
const stateKey = 'voivoxCaptureState';

export async function getBridgeConfig(): Promise<BridgeConfig | undefined> {
  const stored = await chrome.storage.local.get(bridgeKey);
  const config = stored[bridgeKey] as Partial<BridgeConfig> | undefined;
  if (!config || typeof config.baseUrl !== 'string' || typeof config.token !== 'string') {
    return undefined;
  }
  return { baseUrl: config.baseUrl.replace(/\/$/, ''), token: config.token };
}

export function saveBridgeConfig(config: BridgeConfig): Promise<void> {
  return chrome.storage.local.set({ [bridgeKey]: { baseUrl: config.baseUrl.replace(/\/$/, ''), token: config.token } });
}

export async function getCaptureState(): Promise<CaptureState> {
  const stored = await chrome.storage.local.get(stateKey);
  return (stored[stateKey] as CaptureState | undefined) ?? { active: false };
}

export function saveCaptureState(state: CaptureState): Promise<void> {
  return chrome.storage.local.set({ [stateKey]: state });
}
