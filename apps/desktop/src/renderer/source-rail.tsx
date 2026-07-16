import type { DesktopCaptureSource } from './types.js';

const sources: Array<{ source: DesktopCaptureSource; description: string }> = [
  {
    source: { kind: 'chrome-tab', label: '当前 Chrome 标签页' },
    description: '用扩展静音采集当前标签页'
  },
  {
    source: { kind: 'macos-process', label: '选择 macOS 应用' },
    description: '只监听一个应用的输出声音'
  },
];

export function SourceRail({
  disabled,
  selected,
  onSelect
}: {
  disabled: boolean;
  selected: DesktopCaptureSource;
  onSelect: (source: DesktopCaptureSource) => void;
}) {
  return (
    <nav aria-label="收录来源" className="source-rail">
      <p className="rail-kicker">INPUT</p>
      <h2>声音来自哪里？</h2>
      <div className="source-list">
        {sources.map(({ source, description }) => {
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
              <span className="source-dot" aria-hidden="true" />
              <span>
                <strong>{source.label}</strong>
                <small>{description}</small>
              </span>
            </button>
          );
        })}
      </div>
      <p className="rail-footnote">不会接管你的输入法、剪贴板或其他 App 的声音。</p>
    </nav>
  );
}
