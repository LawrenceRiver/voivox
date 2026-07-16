export type DesktopCaptureSource = {
  kind: 'chrome-tab' | 'macos-process' | 'microphone';
  label: string;
  processId?: number;
};

export type DesktopSegment = {
  startMs: number;
  endMs: number;
  text: string;
};

export type DesktopSession = {
  id: string;
  source: DesktopCaptureSource;
  status: 'capturing' | 'complete' | 'interrupted';
  createdAt?: string;
  rawSegments?: DesktopSegment[];
};

export type DesktopDashboard = {
  activeSession?: DesktopSession;
  sessions: DesktopSession[];
};

export type DesktopCapabilities = {
  extensionDiscovery: boolean;
  localAsr: 'checking' | 'ready' | 'missing';
};
