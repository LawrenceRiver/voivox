import type { DesktopSession } from './types.js';

export function SessionList({ sessions }: { sessions: DesktopSession[] }) {
  return (
    <section aria-labelledby="sessions-heading" className="session-list-panel">
      <div className="section-title-row">
        <div>
          <p className="rail-kicker">LOCAL LIBRARY</p>
          <h2 id="sessions-heading">最近收录</h2>
        </div>
        <span>{sessions.length} 条</span>
      </div>
      {sessions.length > 0 ? (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <span className={`session-state ${session.status}`} aria-label={session.status === 'capturing' ? '正在收录' : '已完成'} />
              <div>
                <strong>{session.source.label}</strong>
                <small>{session.status === 'capturing' ? '正在收录' : '原始转写已保存到本机'}</small>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="session-empty">还没有收录内容。完成一次后，Codex MCP 也能读取这里的原文。</p>
      )}
    </section>
  );
}
