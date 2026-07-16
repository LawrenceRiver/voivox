import type { TranscriptionMode, TranscriptionRoute } from './local-transcription.js';

export type BridgeConfig = {
  baseUrl: string;
  token: string;
};

export type CaptureErrorCode = 'transcription-cancelled' | 'transcription-timeout';

export type CaptureState = {
  active: boolean;
  canRetry?: boolean;
  mode: TranscriptionMode;
  phase: 'idle' | 'capturing' | 'downloading' | 'transcribing' | 'complete' | 'error';
  progress?: number;
  route?: Exclude<TranscriptionRoute, 'unavailable'>;
  sessionId?: string;
  tabTitle?: string;
  error?: string;
  errorCode?: CaptureErrorCode;
  transcript?: string;
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
  return normalizeCaptureState(stored[stateKey]);
}

export function saveCaptureState(state: CaptureState): Promise<void> {
  return chrome.storage.local.set({ [stateKey]: state });
}

export function normalizeCaptureState(value: unknown): CaptureState {
  const record = isRecord(value) ? value : {};
  const active = record.active === true;
  const state: CaptureState = {
    active,
    mode: record.mode === 'fast' || record.mode === 'quality' ? record.mode : 'quality',
    phase: isCapturePhase(record.phase) ? record.phase : active ? 'capturing' : 'idle'
  };

  if (record.canRetry === true) state.canRetry = true;
  if (typeof record.error === 'string') state.error = record.error;
  if (record.errorCode === 'transcription-cancelled' || record.errorCode === 'transcription-timeout') {
    state.errorCode = record.errorCode;
  }
  if (typeof record.progress === 'number' && record.progress >= 0 && record.progress <= 100) {
    state.progress = record.progress;
  }
  if (record.route === 'browser-local') state.route = record.route;
  if (typeof record.sessionId === 'string') state.sessionId = record.sessionId;
  if (typeof record.tabTitle === 'string') state.tabTitle = record.tabTitle;
  if (typeof record.transcript === 'string') state.transcript = record.transcript;
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCapturePhase(value: unknown): value is CaptureState['phase'] {
  return value === 'idle'
    || value === 'capturing'
    || value === 'downloading'
    || value === 'transcribing'
    || value === 'complete'
    || value === 'error';
}
