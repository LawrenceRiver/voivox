import { translate, type Locale } from '@voivox/i18n';

import type { DesktopCaptureSource, DesktopSession } from './types.js';

const genericChromeLabels = new Set([
  '当前 Chrome 标签页',
  'Chrome 标签页',
  'Current Chrome tab',
  'Chrome tab'
]);

export function localizedSessionSourceLabel(locale: Locale, source: DesktopCaptureSource): string {
  if (source.kind === 'chrome-tab' && genericChromeLabels.has(source.label.trim())) {
    return translate(locale, 'desktop.source.chromeLabel');
  }
  return source.label;
}

export function sessionStatusLabel(locale: Locale, status: DesktopSession['status']): string {
  if (status === 'capturing') {
    return translate(locale, 'desktop.sessions.capturing');
  }
  if (status === 'interrupted') {
    return translate(locale, 'desktop.sessions.interrupted');
  }
  return translate(locale, 'desktop.sessions.saved');
}

export function SessionList({
  locale,
  onSelect,
  selectedSessionId,
  sessions
}: {
  locale: Locale;
  onSelect: (sessionId: string) => void;
  selectedSessionId?: string;
  sessions: DesktopSession[];
}) {
  return (
    <section aria-labelledby="sessions-heading" className="session-list-panel">
      <div className="section-title-row panel-title-row">
        <div className="section-heading compact-heading">
          <span className="eyebrow">{translate(locale, 'desktop.sessions.eyebrow')}</span>
          <h2 id="sessions-heading">{translate(locale, 'sessions.title')}</h2>
        </div>
        <span className="count-badge">{translate(locale, 'desktop.sessions.count', { count: sessions.length })}</span>
      </div>
      {sessions.length > 0 ? (
        <ul className="session-list">
          {sessions.map((session) => (
            <li className={selectedSessionId === session.id ? 'is-selected' : ''} key={session.id}>
              <button aria-pressed={selectedSessionId === session.id} onClick={() => onSelect(session.id)} type="button">
                <span className={`session-state ${session.status}`} aria-hidden="true" />
                <span>
                  <strong>{localizedSessionSourceLabel(locale, session.source)}</strong>
                  <small>{sessionStatusLabel(locale, session.status)}</small>
                </span>
                <span aria-hidden="true" className="session-arrow">→</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="history-empty">
          <span aria-hidden="true" className="empty-sheet"><i /><i /><i /></span>
          <p>{translate(locale, 'desktop.sessions.empty')}</p>
        </div>
      )}
    </section>
  );
}
