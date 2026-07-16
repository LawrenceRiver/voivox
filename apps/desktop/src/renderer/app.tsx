import { useEffect, useMemo, useState } from 'react';

import { deriveCapturePresentation } from './dashboard-state.js';
import { ChromeBridgePanel } from './chrome-bridge-panel.js';
import { MacProcessPicker, type MacProcess } from './mac-process-picker.js';
import { SessionList } from './session-list.js';
import { SourceRail } from './source-rail.js';
import { TranscriptPanel } from './transcript-panel.js';
import type { DesktopCaptureSource, DesktopDashboard, DesktopSession } from './types.js';

export type DesktopClient = {
  getDashboard: () => Promise<DesktopDashboard>;
  setCaptureMode?: (mode: 'fast' | 'normal') => Promise<void>;
  startCapture: (source: DesktopCaptureSource) => Promise<Pick<DesktopSession, 'id' | 'status'>>;
  stopCapture: (sessionId: string) => Promise<void>;
  appendDemoSegment: (sessionId: string) => Promise<void>;
  getChromeBridge?: () => Promise<{ baseUrl: string; token: string }>;
  listMacProcesses?: () => Promise<MacProcess[]>;
  onAsrError?: (listener: (message: string) => void) => () => void;
};

const defaultSource: DesktopCaptureSource = {
  kind: 'chrome-tab',
  label: '当前 Chrome 标签页'
};

export function App({ desktopClient }: { desktopClient: DesktopClient }) {
  const [dashboard, setDashboard] = useState<DesktopDashboard>({ sessions: [] });
  const [source, setSource] = useState<DesktopCaptureSource>(defaultSource);
  const [captureMode, setCaptureMode] = useState<'fast' | 'normal'>('normal');
  const [error, setError] = useState<string>();
  const [isWorking, setIsWorking] = useState(false);
  const [bridgeRevealSignal, setBridgeRevealSignal] = useState(0);
  const [processPicker, setProcessPicker] = useState<{ error?: string; loading: boolean; open: boolean; processes: MacProcess[] }>({ loading: false, open: false, processes: [] });

  const presentation = useMemo(
    () => deriveCapturePresentation({ sourceKind: source.kind, sourceLabel: source.label, activeSession: dashboard.activeSession }),
    [dashboard.activeSession, source.kind, source.label]
  );

  useEffect(() => {
    void refresh();
    // The desktop bridge is created once by preload; refreshing it here would not change state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => desktopClient.onAsrError?.((message) => setError(message)), [desktopClient]);

  async function refresh(): Promise<void> {
    try {
      setDashboard(await desktopClient.getDashboard());
      setError(undefined);
    } catch {
      setError('无法连接到 VOIVOX 本地引擎。请重新打开 App。');
    }
  }

  async function handleCapture(): Promise<void> {
    setIsWorking(true);
    setError(undefined);
    try {
      if (dashboard.activeSession?.status === 'capturing') {
        await desktopClient.stopCapture(dashboard.activeSession.id);
      } else if (source.kind === 'chrome-tab') {
        setBridgeRevealSignal((signal) => signal + 1);
        setError('请在 Chrome 扩展中点击“开始静音收录”。');
        return;
      } else {
        await desktopClient.startCapture(source);
      }
      await refresh();
    } catch {
      setError('这个来源暂时无法开始收录。请检查扩展、权限或本地声音宿主。');
    } finally {
      setIsWorking(false);
    }
  }

  async function handleSourceSelect(nextSource: DesktopCaptureSource): Promise<void> {
    if (nextSource.kind !== 'macos-process') {
      setSource(nextSource);
      return;
    }
    if (!desktopClient.listMacProcesses) {
      setError('macOS 进程收录宿主不可用。请重新安装或打开 VOIVOX。');
      return;
    }
    setProcessPicker({ loading: true, open: true, processes: [] });
    try {
      setProcessPicker({ loading: false, open: true, processes: await desktopClient.listMacProcesses() });
    } catch {
      setProcessPicker({ error: '无法读取 macOS 应用列表。请授予系统音频录制权限后重试。', loading: false, open: true, processes: [] });
    }
  }

  async function handleCaptureMode(nextMode: 'fast' | 'normal'): Promise<void> {
    setError(undefined);
    try {
      await desktopClient.setCaptureMode?.(nextMode);
      setCaptureMode(nextMode);
    } catch {
      setError('无法切换本机转写分段。请重新打开 VOIVOX 后重试。');
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <a aria-label="VOIVOX 首页" className="wordmark" href="#top">VOI<span>VOX</span></a>
        <p className="engine-status"><span aria-hidden="true" /> 本地核心已就绪</p>
      </header>
      <div className="workspace" id="top">
        <SourceRail disabled={!presentation.canChangeSource || isWorking} onSelect={(nextSource) => void handleSourceSelect(nextSource)} selected={source} />
        <div className="capture-workspace">
          <section aria-labelledby="capture-heading" className="capture-summary">
            <div>
              <p className="rail-kicker">SILENT CAPTURE</p>
              <h1 id="capture-heading">{source.label}</h1>
              <p aria-live="polite" className="capture-notice">{presentation.notice}</p>
            </div>
            <div className="capture-controls">
              <p className={`capture-status ${dashboard.activeSession?.status === 'capturing' ? 'is-live' : ''}`}>
                <span aria-hidden="true" />{presentation.statusLabel}
              </p>
              <button className="capture-button" disabled={isWorking} onClick={() => void handleCapture()} type="button">
                {isWorking ? '正在连接…' : presentation.actionLabel}
              </button>
            </div>
          </section>
          <section aria-label="转写分段" className="capture-mode">
            <div>
              <p className="rail-kicker">TRANSCRIPTION WINDOW</p>
              <p>{source.kind === 'macos-process'
                ? '所选 macOS 应用会在停止后转写；此选项会保留给下一次 Chrome 实时收录。'
                : '快速模式更快出现文本；标准模式给本机模型更多上下文。'}</p>
            </div>
            <div aria-label="转写速度" className="mode-options" role="group">
              <button aria-pressed={captureMode === 'fast'} disabled={!presentation.canChangeSource || isWorking} onClick={() => void handleCaptureMode('fast')} type="button">快速 · 4 秒</button>
              <button aria-pressed={captureMode === 'normal'} disabled={!presentation.canChangeSource || isWorking} onClick={() => void handleCaptureMode('normal')} type="button">标准 · 8 秒</button>
            </div>
          </section>
          {error ? <p className="error-callout" role="alert">{error}</p> : null}
          <TranscriptPanel session={dashboard.activeSession} />
          <SessionList sessions={dashboard.sessions} />
          <ChromeBridgePanel getBridge={desktopClient.getChromeBridge} revealSignal={bridgeRevealSignal} />
        </div>
      </div>
      {processPicker.open ? <MacProcessPicker error={processPicker.error} loading={processPicker.loading} onClose={() => setProcessPicker({ loading: false, open: false, processes: [] })} onSelect={(process) => {
        setSource({ kind: 'macos-process', label: process.name, processId: process.pid });
        setProcessPicker({ loading: false, open: false, processes: [] });
      }} processes={processPicker.processes} /> : null}
    </main>
  );
}
