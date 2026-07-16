import type { DesktopSession } from './types.js';

export function TranscriptPanel({ session }: { session?: DesktopSession }) {
  const segments = session?.rawSegments ?? [];
  const latestTime = segments.at(-1)?.endMs ?? 0;

  return (
    <section aria-labelledby="transcript-heading" className="transcript-panel">
      <div className="panel-heading">
        <div>
          <p className="rail-kicker">LIVE TRANSCRIPT</p>
          <h2 id="transcript-heading">原始转写</h2>
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
              <p>{session ? '等待本地转写引擎返回第一段文字。' : '选择来源后开始收录，转写会出现在这里。'}</p>
              <span>原始文本会保留时间戳，AI 整理只会生成一个副本。</span>
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
