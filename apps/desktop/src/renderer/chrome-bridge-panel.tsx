import { useEffect, useState } from 'react';

export type ChromeBridge = {
  baseUrl: string;
  token: string;
};

export function ChromeBridgePanel({
  getBridge,
  revealSignal = 0
}: {
  getBridge?: () => Promise<ChromeBridge>;
  revealSignal?: number;
}) {
  const [bridge, setBridge] = useState<ChromeBridge>();
  const [error, setError] = useState<string>();

  async function revealBridge(): Promise<void> {
    if (!getBridge) {
      setError('桌面桥接暂不可用。请重新打开 Voice Vac。');
      return;
    }
    try {
      setBridge(await getBridge());
      setError(undefined);
    } catch {
      setError('无法生成 Chrome 桥接信息。请重新打开 Voice Vac。');
    }
  }

  useEffect(() => {
    if (revealSignal > 0) {
      void revealBridge();
    }
  // `revealSignal` changes only after an explicit desktop-app action.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSignal]);

  return (
    <section aria-labelledby="chrome-bridge-heading" className="chrome-bridge-panel">
      <div className="section-title-row">
        <div>
          <p className="rail-kicker">CHROME COMPANION</p>
          <h2 id="chrome-bridge-heading">连接标签页扩展</h2>
        </div>
        <button className="text-button" onClick={() => void revealBridge()} type="button">
          {bridge ? '重新显示连接' : '显示 Chrome 连接'}
        </button>
      </div>
      {bridge ? (
        <div className="bridge-fields">
          <p>把这两项粘贴到扩展的“连接本机 App”中。它只能提交当前标签页的音频，不能读会话或使用 MCP。</p>
          <label>本机地址<input aria-label="本机地址" readOnly value={bridge.baseUrl} /></label>
          <label>Chrome 桥接令牌<input aria-label="Chrome 桥接令牌" readOnly value={bridge.token} /></label>
        </div>
      ) : (
        <p className="session-empty">扩展只在你从其弹窗点击开始时获取当前 Chrome 标签页的声音。</p>
      )}
      {error ? <p className="error-callout" role="alert">{error}</p> : null}
    </section>
  );
}
