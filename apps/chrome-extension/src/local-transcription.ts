export type TranscriptionMode = 'fast' | 'quality';

export type BrowserModelSpec = {
  approximateDownloadMb: number;
  dtype: 'q8';
  id: string;
  revision: string;
};

export type LocalAsrAvailability = 'checking' | 'ready' | 'missing';

export type DesktopDiscovery = {
  reachable: boolean;
  localAsr?: LocalAsrAvailability;
};

export type TranscriptionRoute = 'desktop-local' | 'browser-local' | 'unavailable';

const browserModels = {
  fast: {
    approximateDownloadMb: 45,
    dtype: 'q8',
    id: 'onnx-community/whisper-tiny',
    revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7'
  },
  quality: {
    approximateDownloadMb: 80,
    dtype: 'q8',
    id: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925'
  }
} as const satisfies Record<TranscriptionMode, BrowserModelSpec>;

export function browserModelForMode(mode: TranscriptionMode): BrowserModelSpec {
  return browserModels[mode];
}

export function chooseTranscriptionRoute(
  desktop: DesktopDiscovery,
  browserLocalSupported: boolean
): TranscriptionRoute {
  if (desktop.reachable && desktop.localAsr === 'ready') {
    return 'desktop-local';
  }
  return browserLocalSupported ? 'browser-local' : 'unavailable';
}
