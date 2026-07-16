import { useEffect, useRef } from 'react';
import { translate, type Locale } from '@voivox/i18n';

export type MacProcess = { bundleId: string; name: string; pid: number };

export function presentMacApplications(processes: MacProcess[]): MacProcess[] {
  const seen = new Set<string>();
  return processes.filter((process) => {
    if (!process.bundleId && /^Audio process \d+$/u.test(process.name)) {
      return false;
    }
    const key = `${process.bundleId}\u0000${process.name}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function MacProcessPicker({
  error,
  locale,
  loading,
  processes,
  onClose,
  onSelect
}: {
  error?: string;
  locale: Locale;
  loading: boolean;
  processes: MacProcess[];
  onClose: () => void;
  onSelect: (process: MacProcess) => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const applications = presentMacApplications(processes);
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    closeButton.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div aria-modal="true" className="process-picker-backdrop" role="dialog" aria-labelledby="process-picker-title">
      <section className="process-picker" ref={dialog}>
        <div className="section-title-row panel-title-row">
          <div className="section-heading compact-heading"><span className="eyebrow">{translate(locale, 'desktop.picker.eyebrow')}</span><h2 id="process-picker-title">{translate(locale, 'desktop.picker.title')}</h2></div>
          <button aria-label={translate(locale, 'common.close')} className="dialog-close" onClick={onClose} ref={closeButton} type="button">×</button>
        </div>
        <p className="experimental-note"><span aria-hidden="true" />{translate(locale, 'desktop.capture.macNotice')}</p>
        {loading ? <p aria-live="polite" className="picker-message" role="status">{translate(locale, 'desktop.picker.loading')}</p> : null}
        {error ? <p className="error-callout" role="alert">{error}</p> : null}
        {!loading && !error && applications.length > 0 ? (
          <ul className="process-list">
            {applications.map((process) => (
              <li key={process.pid}>
                <button onClick={() => onSelect(process)} type="button">
                  <span aria-hidden="true" className="app-tile">{process.name.slice(0, 1).toLocaleUpperCase(locale)}</span>
                  <span className="app-name"><strong>{process.name}</strong><small>{process.bundleId || 'macOS'}</small></span>
                  <span aria-hidden="true" className="picker-arrow">→</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {!loading && !error && applications.length === 0 ? <p aria-live="polite" className="picker-message" role="status">{translate(locale, 'desktop.picker.empty')}</p> : null}
      </section>
    </div>
  );
}
