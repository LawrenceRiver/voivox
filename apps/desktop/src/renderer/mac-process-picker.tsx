import { useEffect, useRef } from 'react';

export type MacProcess = { bundleId: string; name: string; pid: number };

export function MacProcessPicker({
  error,
  loading,
  processes,
  onClose,
  onSelect
}: {
  error?: string;
  loading: boolean;
  processes: MacProcess[];
  onClose: () => void;
  onSelect: (process: MacProcess) => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => closeButton.current?.focus(), []);

  return (
    <div aria-modal="true" className="process-picker-backdrop" role="dialog" aria-labelledby="process-picker-title">
      <section className="process-picker">
        <div className="section-title-row">
          <div><p className="rail-kicker">MACOS PROCESS TAP</p><h2 id="process-picker-title">选择要静音收录的 App</h2></div>
          <button className="text-button" onClick={onClose} ref={closeButton} type="button">关闭</button>
        </div>
        {loading ? <p className="session-empty">正在查询 macOS 中可选的进程…</p> : null}
        {error ? <p className="error-callout" role="alert">{error}</p> : null}
        {!loading && !error ? (
          <ul className="process-list">
            {processes.map((process) => (
              <li key={process.pid}>
                <button onClick={() => onSelect(process)} type="button">
                  <span>{process.name}</span><small>{process.bundleId || `pid ${process.pid}`}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
