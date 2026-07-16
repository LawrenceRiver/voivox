import { translate, type Locale } from '@voivox/i18n';

import type { DesktopCaptureSource } from './types.js';

export function SourceRail({
  disabled,
  locale,
  selected,
  onSelect
}: {
  disabled: boolean;
  locale: Locale;
  selected: DesktopCaptureSource;
  onSelect: (source: DesktopCaptureSource) => void;
}) {
  const sources: Array<{
    badge: string;
    description: string;
    glyph: 'browser' | 'window';
    source: DesktopCaptureSource;
  }> = [
    {
      badge: translate(locale, 'desktop.source.chromeBadge'),
      description: translate(locale, 'desktop.source.chromeHint'),
      glyph: 'browser',
      source: { kind: 'chrome-tab', label: translate(locale, 'desktop.source.chromeLabel') }
    },
    {
      badge: translate(locale, 'desktop.source.macBadge'),
      description: translate(locale, 'desktop.source.macHint'),
      glyph: 'window',
      source: { kind: 'macos-process', label: translate(locale, 'desktop.source.macLabel') }
    }
  ];

  return (
    <nav aria-label={translate(locale, 'source.title')} className="source-picker">
      <div className="section-heading compact-heading">
        <span className="eyebrow">{translate(locale, 'desktop.step.source')}</span>
        <h2>{translate(locale, 'source.title')}</h2>
      </div>
      <div className="source-list">
        {sources.map(({ badge, description, glyph, source }) => {
          const selectedSource = source.kind === selected.kind;
          return (
            <button
              aria-pressed={selectedSource}
              className="source-option"
              disabled={disabled}
              key={source.kind}
              onClick={() => onSelect(source)}
              type="button"
            >
              <span aria-hidden="true" className={`source-glyph is-${glyph}`}>
                <i /><i /><i />
              </span>
              <span className="source-copy">
                <span className="source-title-row">
                  <strong>{source.label}</strong>
                  <small>{badge}</small>
                </span>
                <span className="source-description">{description}</span>
              </span>
              <span aria-hidden="true" className="source-check" />
            </button>
          );
        })}
      </div>
    </nav>
  );
}
