import { useEffect, useMemo, useState } from 'react';
import { resolveLocale, translate, type Locale, type MessageKey } from '@voivox/i18n';

import { deriveCapturePresentation } from './dashboard-state.js';
import { MacProcessPicker, type MacProcess } from './mac-process-picker.js';
import { SessionList } from './session-list.js';
import { SourceRail } from './source-rail.js';
import { TranscriptPanel } from './transcript-panel.js';
import type {
  DesktopCapabilities,
  DesktopCaptureSource,
  DesktopDashboard,
  DesktopSession
} from './types.js';

export type DesktopClient = {
  getDashboard: () => Promise<DesktopDashboard>;
  getCapabilities?: () => Promise<DesktopCapabilities>;
  setCaptureMode?: (mode: 'fast' | 'normal') => Promise<void>;
  startCapture: (source: DesktopCaptureSource) => Promise<Pick<DesktopSession, 'id' | 'status'>>;
  stopCapture: (sessionId: string) => Promise<void>;
  appendDemoSegment: (sessionId: string) => Promise<void>;
  listMacProcesses?: () => Promise<MacProcess[]>;
  onAsrError?: (listener: (message: string) => void) => () => void;
};

const mascotUrl = new URL('../../build/icon.png', import.meta.url).href;
const defaultCapabilities: DesktopCapabilities = {
  extensionDiscovery: false,
  localAsr: 'checking'
};

function initialLocale(): Locale {
  let persisted: string | null = null;
  try {
    persisted = window.localStorage.getItem('voivoxLocale');
  } catch {
    // A locked-down renderer can still follow the system locale.
  }
  return resolveLocale(window.navigator.language, persisted);
}

export function App({ desktopClient }: { desktopClient: DesktopClient }) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [dashboard, setDashboard] = useState<DesktopDashboard>({ sessions: [] });
  const [capabilities, setCapabilities] = useState<DesktopCapabilities>(defaultCapabilities);
  const [coreConnected, setCoreConnected] = useState(false);
  const [source, setSource] = useState<DesktopCaptureSource>(() => ({
    kind: 'chrome-tab',
    label: translate(initialLocale(), 'desktop.source.chromeLabel')
  }));
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [asrError, setAsrError] = useState<string>();
  const [connectionError, setConnectionError] = useState<string>();
  const [instruction, setInstruction] = useState<string>();
  const [isWorking, setIsWorking] = useState(false);
  const [processPicker, setProcessPicker] = useState<{
    error?: string;
    loading: boolean;
    open: boolean;
    processes: MacProcess[];
  }>({ loading: false, open: false, processes: [] });

  const t = (key: MessageKey, variables?: Readonly<Record<string, string | number>>): string =>
    translate(locale, key, variables);

  const presentation = useMemo(
    () => deriveCapturePresentation({
      sourceKind: source.kind,
      sourceLabel: source.label,
      activeSession: dashboard.activeSession
    }, locale),
    [dashboard.activeSession, locale, source.kind, source.label]
  );
  const transcriptSession = useMemo(
    () => dashboard.activeSession
      ?? dashboard.sessions.find((session) => session.id === selectedSessionId)
      ?? dashboard.sessions[0],
    [dashboard.activeSession, dashboard.sessions, selectedSessionId]
  );

  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      window.localStorage.setItem('voivoxLocale', locale);
    } catch {
      // Locale still applies for this session when persistence is unavailable.
    }
    setSource((current) => {
      if (current.kind === 'chrome-tab') {
        return { ...current, label: translate(locale, 'desktop.source.chromeLabel') };
      }
      if (current.kind === 'macos-process' && !current.processId) {
        return { ...current, label: translate(locale, 'desktop.source.macLabel') };
      }
      return current;
    });
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const loadDashboard = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const nextDashboard = await desktopClient.getDashboard();
        if (!cancelled) {
          setDashboard(nextDashboard);
          setCoreConnected(true);
          setConnectionError(undefined);
        }
      } catch {
        if (!cancelled) {
          setCoreConnected(false);
          setConnectionError(translate(locale, 'desktop.error.core'));
        }
      } finally {
        inFlight = false;
      }
    };
    void loadDashboard();
    const interval = setInterval(() => void loadDashboard(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [desktopClient, locale]);

  useEffect(() => {
    if (!desktopClient.getCapabilities) {
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async (): Promise<void> => {
      try {
        const nextCapabilities = await desktopClient.getCapabilities?.();
        if (!cancelled && nextCapabilities) {
          setCapabilities(nextCapabilities);
          if (nextCapabilities.localAsr === 'checking') {
            timer = setTimeout(() => void check(), 1_500);
          }
        }
      } catch {
        if (!cancelled) {
          setCapabilities((current) => ({ ...current, localAsr: 'missing' }));
        }
      }
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [desktopClient]);

  useEffect(() => desktopClient.onAsrError?.((message) => setAsrError(message)), [desktopClient]);

  useEffect(() => {
    if (dashboard.activeSession) {
      setSelectedSessionId(dashboard.activeSession.id);
    }
  }, [dashboard.activeSession]);

  async function refresh(): Promise<void> {
    try {
      setDashboard(await desktopClient.getDashboard());
      setCoreConnected(true);
      setConnectionError(undefined);
    } catch {
      setCoreConnected(false);
      setConnectionError(t('desktop.error.core'));
    }
  }

  async function handleCapture(): Promise<void> {
    setIsWorking(true);
    setActionError(undefined);
    setAsrError(undefined);
    setInstruction(undefined);
    try {
      if (dashboard.activeSession?.status === 'capturing') {
        await desktopClient.stopCapture(dashboard.activeSession.id);
      } else if (source.kind === 'chrome-tab') {
        setInstruction(t('desktop.capture.chromeInstruction'));
        return;
      } else {
        const started = await desktopClient.startCapture(source);
        setSelectedSessionId(started.id);
      }
      await refresh();
    } catch {
      setActionError(t('desktop.error.capture'));
    } finally {
      setIsWorking(false);
    }
  }

  async function handleSourceSelect(nextSource: DesktopCaptureSource): Promise<void> {
    setInstruction(undefined);
    setActionError(undefined);
    if (nextSource.kind !== 'macos-process') {
      setSource(nextSource);
      return;
    }
    if (!desktopClient.listMacProcesses) {
      setActionError(t('desktop.error.processHost'));
      return;
    }
    setProcessPicker({ loading: true, open: true, processes: [] });
    try {
      setProcessPicker({ loading: false, open: true, processes: await desktopClient.listMacProcesses() });
    } catch {
      setProcessPicker({
        error: t('desktop.error.processList'),
        loading: false,
        open: true,
        processes: []
      });
    }
  }

  function toggleLocale(): void {
    setLocale((current) => current === 'zh-CN' ? 'en' : 'zh-CN');
  }

  const capturing = dashboard.activeSession?.status === 'capturing';
  const macModelUnavailable = source.kind === 'macos-process' && capabilities.localAsr !== 'ready' && !capturing;
  const displayedError = asrError ?? actionError ?? connectionError;

  return (
    <main className="app-shell" id="top">
      <header className="app-header">
        <a aria-label="VOIVOX" className="brand" href="#top">
          <span aria-hidden="true" className="brand-mark"><i /><i /><i /></span>
          <span>VOI<strong>VOX</strong></span>
        </a>
        <button
          aria-label={t(locale === 'zh-CN' ? 'desktop.language.switchEnglish' : 'desktop.language.switchChinese')}
          className="language-toggle"
          onClick={toggleLocale}
          type="button"
        >
          <span className={locale === 'zh-CN' ? 'is-current' : ''}>中</span>
          <i aria-hidden="true" />
          <span className={locale === 'en' ? 'is-current' : ''}>EN</span>
        </button>
      </header>

      <div className="app-canvas">
        <section className="hero-card">
          <div className="hero-copy">
            <span className="eyebrow">{t('desktop.hero.eyebrow')}</span>
            <h1>{t('desktop.hero.title')}</h1>
            <p>{t('desktop.hero.description')}</p>
            <span className="privacy-note"><i aria-hidden="true" />{t('privacy.localOnly')}</span>
          </div>
          <div aria-hidden="true" className="mascot-stage">
            <span className="sound-ribbon ribbon-one" />
            <span className="sound-ribbon ribbon-two" />
            <span className="sound-ribbon ribbon-three" />
            <img alt="" src={mascotUrl} />
            <span className="mascot-status-light" />
          </div>
          <img alt={t('desktop.mascotAlt')} className="accessible-mascot" src={mascotUrl} />
        </section>

        <div className="workspace-grid">
          <section className="capture-console">
            <SourceRail
              disabled={!presentation.canChangeSource || isWorking}
              locale={locale}
              onSelect={(nextSource) => void handleSourceSelect(nextSource)}
              selected={source}
            />

            <section aria-labelledby="capture-heading" className={`capture-stage ${capturing ? 'is-live' : ''}`}>
              <div className="capture-stage-copy">
                <span className="eyebrow">{t('desktop.step.capture')}</span>
                <div className="capture-title-row">
                  <div>
                    <h2 id="capture-heading">{source.label}</h2>
                    {source.kind === 'macos-process' ? <span className="experimental-pill">{t('desktop.source.macBadge')}</span> : null}
                  </div>
                  <p className="capture-status"><span aria-hidden="true" />{presentation.statusLabel}</p>
                </div>
                <p aria-live="polite" className="capture-notice">{presentation.notice}</p>
                {instruction ? <p aria-live="polite" className="instruction-callout"><span aria-hidden="true">↗</span>{instruction}</p> : null}
                {displayedError ? <p className="error-callout" role="alert">{displayedError}</p> : null}
              </div>

              <div className="capture-action-row">
                <div aria-hidden="true" className="capture-wave">
                  <i /><i /><i /><i /><i /><i /><i />
                </div>
                <button
                  className="capture-button"
                  disabled={isWorking || macModelUnavailable}
                  onClick={() => void handleCapture()}
                  type="button"
                >
                  <span aria-hidden="true" className="button-orb" />
                  {isWorking ? t('desktop.capture.connecting') : presentation.actionLabel}
                  <span aria-hidden="true" className="button-arrow">→</span>
                </button>
              </div>
            </section>

            <TranscriptPanel locale={locale} session={transcriptSession} />
          </section>

          <aside className="status-column">
            <HealthPanel capabilities={capabilities} coreConnected={coreConnected} locale={locale} />
            <SessionList
              locale={locale}
              onSelect={setSelectedSessionId}
              selectedSessionId={transcriptSession?.id}
              sessions={dashboard.sessions}
            />
          </aside>
        </div>
      </div>

      {processPicker.open ? (
        <MacProcessPicker
          error={processPicker.error}
          loading={processPicker.loading}
          locale={locale}
          onClose={() => setProcessPicker({ loading: false, open: false, processes: [] })}
          onSelect={(process) => {
            setSource({ kind: 'macos-process', label: process.name, processId: process.pid });
            setProcessPicker({ loading: false, open: false, processes: [] });
          }}
          processes={processPicker.processes}
        />
      ) : null}
    </main>
  );
}

function HealthPanel({
  capabilities,
  coreConnected,
  locale
}: {
  capabilities: DesktopCapabilities;
  coreConnected: boolean;
  locale: Locale;
}) {
  const t = (key: MessageKey): string => translate(locale, key);
  const modelCopy: Record<DesktopCapabilities['localAsr'], { hint: MessageKey; label: MessageKey; tone: string }> = {
    checking: {
      hint: 'desktop.health.modelCheckingHint',
      label: 'desktop.health.modelChecking',
      tone: 'checking'
    },
    missing: {
      hint: 'desktop.health.modelMissingHint',
      label: 'desktop.health.modelMissing',
      tone: 'quiet'
    },
    ready: {
      hint: 'desktop.health.modelReadyHint',
      label: 'desktop.health.modelReady',
      tone: 'ready'
    }
  };
  const model = modelCopy[capabilities.localAsr];

  return (
    <section aria-labelledby="health-heading" className="health-panel">
      <div className="section-heading compact-heading">
        <span className="eyebrow">{t('desktop.step.system')}</span>
        <h2 id="health-heading">{t('desktop.health.title')}</h2>
      </div>
      <div className="health-list">
        <article className={`health-card tone-${model.tone}`}>
          <span aria-hidden="true" className="health-icon model-icon"><i /><i /><i /></span>
          <div>
            <small>{t('desktop.health.modelTitle')}</small>
            <strong>{t(model.label)}</strong>
            <p>{t(model.hint)}</p>
          </div>
          <span aria-hidden="true" className="health-dot" />
        </article>
        <article className={`health-card ${capabilities.extensionDiscovery ? 'tone-ready' : 'tone-quiet'}`}>
          <span aria-hidden="true" className="health-icon extension-icon"><i /></span>
          <div>
            <small>{t('desktop.health.extensionTitle')}</small>
            <strong>{t(capabilities.extensionDiscovery ? 'desktop.health.extensionAuto' : 'desktop.health.extensionStandalone')}</strong>
            <p>{t(capabilities.extensionDiscovery ? 'desktop.health.extensionAutoHint' : 'desktop.health.extensionStandaloneHint')}</p>
          </div>
          <span aria-hidden="true" className="health-dot" />
        </article>
        <article className={`health-card ${coreConnected ? 'tone-ready' : 'tone-checking'}`}>
          <span aria-hidden="true" className="health-icon mcp-icon">M</span>
          <div>
            <small>{t('desktop.health.mcpTitle')}</small>
            <strong>{coreConnected ? t('desktop.health.mcpReady') : t('status.checking')}</strong>
            <p>{t('desktop.health.mcpHint')}</p>
          </div>
          <span aria-hidden="true" className="health-dot" />
        </article>
      </div>
    </section>
  );
}
