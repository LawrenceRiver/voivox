import type { TranscriptionMode, TranscriptionRoute } from './local-transcription.js';

export type BridgeConfig = {
  baseUrl: string;
  token: string;
};

export type CaptureErrorCode =
  | 'transcription-cancelled'
  | 'transcription-timeout'
  | 'TAB_CLOSED'
  | 'TARGET_NAVIGATED';

export type TunnelPoint = { screenX: number; screenY: number };
export type TunnelRect = { x: number; y: number; width: number; height: number };
export type TunnelLinkState = 'idle' | 'dragging' | 'detecting' | 'ready' | 'transcribing' | 'paused' | 'completed' | 'error';

export type CaptureState = {
  active: boolean;
  canRetry?: boolean;
  mode: TranscriptionMode;
  phase: CapturePhase;
  progress?: number;
  route?: Exclude<TranscriptionRoute, 'unavailable'>;
  sessionId?: string;
  tabTitle?: string;
  tabUrl?: string;
  error?: string;
  errorCode?: CaptureErrorCode;
  transcript?: string;
  linkState?: TunnelLinkState;
  targetRect?: TunnelRect;
  pageEndpoint?: TunnelPoint;
  appEndpoint?: TunnelPoint;
  tunnelSessionId?: string;
};

export type CapturePhase =
  | 'idle'
  | 'armed'
  | 'connecting'
  | 'awaiting-user-play'
  | 'capturing'
  | 'paused'
  | 'downloading'
  | 'transcribing'
  | 'complete'
  | 'error';

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
  return chrome.storage.local.set({ [stateKey]: normalizeCaptureState(state) });
}

export function normalizeCaptureState(value: unknown): CaptureState {
  const record = isRecord(value) ? value : {};
  const active = record.active === true;
  const state: CaptureState = {
    active,
    mode: record.mode === 'fast' || record.mode === 'quality' ? record.mode : 'quality',
    phase: isCapturePhase(record.phase)
      ? record.phase
      : record.phase === undefined && active
        ? 'capturing'
        : 'idle'
  };

  if (record.canRetry === true) state.canRetry = true;
  if (typeof record.error === 'string') state.error = record.error;
  if (record.errorCode === 'transcription-cancelled'
    || record.errorCode === 'transcription-timeout'
    || record.errorCode === 'TAB_CLOSED'
    || record.errorCode === 'TARGET_NAVIGATED') {
    state.errorCode = record.errorCode;
  }
  if (typeof record.progress === 'number' && record.progress >= 0 && record.progress <= 100) {
    state.progress = record.progress;
  }
  if (record.route === 'browser-local') state.route = record.route;
  if (typeof record.sessionId === 'string') state.sessionId = record.sessionId;
  if (typeof record.tabTitle === 'string') state.tabTitle = record.tabTitle;
  if (typeof record.tabUrl === 'string') state.tabUrl = record.tabUrl;
  if (typeof record.transcript === 'string') state.transcript = record.transcript;
  if (isTunnelLinkState(record.linkState)) state.linkState = record.linkState;
  if (isTunnelRect(record.targetRect)) state.targetRect = record.targetRect;
  if (isTunnelPoint(record.pageEndpoint)) state.pageEndpoint = record.pageEndpoint;
  if (isTunnelPoint(record.appEndpoint)) state.appEndpoint = record.appEndpoint;
  if (typeof record.tunnelSessionId === 'string') state.tunnelSessionId = record.tunnelSessionId;
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCapturePhase(value: unknown): value is CaptureState['phase'] {
  return value === 'idle'
    || value === 'armed'
    || value === 'connecting'
    || value === 'awaiting-user-play'
    || value === 'capturing'
    || value === 'paused'
    || value === 'downloading'
    || value === 'transcribing'
    || value === 'complete'
    || value === 'error';
}

function isTunnelLinkState(value: unknown): value is TunnelLinkState {
  return value === 'idle' || value === 'dragging' || value === 'detecting' || value === 'ready'
    || value === 'transcribing' || value === 'paused' || value === 'completed' || value === 'error';
}

function isTunnelPoint(value: unknown): value is TunnelPoint {
  if (!isRecord(value)) return false;
  return Number.isFinite(value.screenX) && Number.isFinite(value.screenY);
}

function isTunnelRect(value: unknown): value is TunnelRect {
  if (!isRecord(value)) return false;
  const x = value.x;
  const y = value.y;
  const width = value.width;
  const height = value.height;
  return typeof x === 'number' && Number.isFinite(x)
    && typeof y === 'number' && Number.isFinite(y)
    && typeof width === 'number' && Number.isFinite(width) && width >= 0
    && typeof height === 'number' && Number.isFinite(height) && height >= 0;
}
