import { translate, type Locale } from '@voivox/i18n';

import type { DesktopSession } from './types.js';

export function TranscriptPanel({ locale, session }: { locale: Locale; session?: DesktopSession }) {
  const segments = session?.rawSegments ?? [];
  const latestTime = segments.at(-1)?.endMs ?? 0;

  return (
    <section aria-labelledby="transcript-heading" className="transcript-panel">
      <div className="panel-heading panel-title-row">
        <div className="section-heading compact-heading">
          <span className="eyebrow">{translate(locale, 'desktop.transcript.eyebrow')}</span>
          <h2 id="transcript-heading">{translate(locale, 'transcript.title')}</h2>
        </div>
        <time className="elapsed-time" dateTime={`PT${Math.floor(latestTime / 1000)}S`}>
          {formatElapsed(latestTime)}
        </time>
      </div>
      <div className="transcript-body">
        <div aria-hidden="true" className={`time-ruler ${session?.status === 'capturing' ? 'is-live' : ''}`} />
        <div className="transcript-content">
          {segments.length > 0 ? (
            <ol className="segment-list">
              {segments.map((segment, index) => (
                <li key={`${segment.startMs}-${index}`}>
                  <time>{formatElapsed(segment.startMs)}</time>
                  <p>{segment.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <div className="transcript-empty">
              <span aria-hidden="true" className="transcript-wave"><i /><i /><i /><i /><i /></span>
              <p>{session ? translate(locale, 'desktop.transcript.waiting') : translate(locale, 'transcript.empty')}</p>
              <span>{translate(locale, 'desktop.transcript.retention')}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function formatElapsed(totalMs: number): string {
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}
