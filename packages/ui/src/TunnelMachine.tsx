import { useState } from 'react';
import type { PvttStatus, TranscriptSegment, TranscriptionMode } from '@voivox/core';

import { tunnelPrimaryLabel, tunnelStatusLabel, type TunnelLocale } from './tunnel-state.js';
import { VacuumMachine3D } from './VacuumMachine3D.js';
import './TunnelMachine.css';

export type TunnelMachineProps = {
  size: 'full' | 'compact' | 'monitor';
  locale: TunnelLocale;
  state: PvttStatus;
  source?: { title: string; url?: string };
  mode: TranscriptionMode;
  segments: TranscriptSegment[];
  transcript: string;
  onModeChange: (mode: TranscriptionMode) => void;
  onPrimaryAction: () => void;
  onStop: () => void;
  onCopy: () => void;
  onClear: () => void;
  onRetry: () => void;
  onTargetDrop?: () => void;
};

export function TunnelMachine({
  size,
  locale,
  state,
  source,
  mode,
  segments,
  transcript,
  onModeChange,
  onPrimaryAction,
  onStop,
  onCopy,
  onClear,
  onRetry,
  onTargetDrop
}: TunnelMachineProps) {
  const [copied, setCopied] = useState(false);
  const zh = locale === 'zh-CN';
  const active = state === 'transcribing' || state === 'paused' || state === 'returning';
  const monitor = size === 'monitor';
  const title = source?.title ?? (zh ? '还没有连接视频' : 'No video connected');
  const primaryLabel = tunnelPrimaryLabel(locale, state);
  const transcriptText = transcript || segments.map((segment) => segment.text).join(' ') || (zh ? '文字会从这里出现。' : 'Your transcript will appear here.');

  function handleCopy(): void {
    onCopy();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  }

  return (
    <section className={`tunnel-machine tunnel-machine--${size} tunnel-machine--${state}`} aria-label="Voice Vac PVTT">
      <div className="tunnel-machine-plaque" aria-hidden="true">
        <span className="tunnel-plaque-screw" />
        <span>PVTT</span>
        <small>{monitor ? 'MCP MONITOR' : 'PRIVATE AUDIO'}</small>
      </div>

      <div className="tunnel-machine-stage">
        <div className="tunnel-3d-shell">
          <VacuumMachine3D active={active} completed={state === 'completed'} locale={locale} onTargetDrop={onTargetDrop} />
          <div className="tunnel-control-column">
            <button
              aria-label={primaryLabel}
              className="tunnel-primary"
              disabled={state === 'detecting' || state === 'connecting' || state === 'returning'}
              onClick={onPrimaryAction}
              type="button"
            >
              <span aria-hidden="true" className={`tunnel-primary-icon tunnel-primary-icon--${active ? 'pause' : 'play'}`} />
            </button>
            <span className="tunnel-primary-label">{primaryLabel}</span>
            {active ? <button className="tunnel-stop" onClick={onStop} type="button">{zh ? '停止' : 'Stop'}</button> : null}
            <div className="tunnel-state" aria-live="polite">
              <span className="tunnel-state-dot" />
              <span>{tunnelStatusLabel(locale, state)}</span>
            </div>
          </div>
        </div>

        <article className="tunnel-output">
          <div className="tunnel-output-notch" aria-hidden="true" />
          <div className="tunnel-output-header">
            <div className="tunnel-output-title">
              <span className="tunnel-kicker">{zh ? '字幕输出舱' : 'TRANSCRIPT BAY'}</span>
              <h2>{title}</h2>
              {source?.url ? <span className="tunnel-source-url">{new URL(source.url).hostname}</span> : <span className="tunnel-source-url">{zh ? '等待来源' : 'Waiting for source'}</span>}
            </div>
            <label className="tunnel-mode">
              <span>{zh ? '模式' : 'MODE'}</span>
              <select aria-label={zh ? '转录模式' : 'Transcription mode'} value={mode} onChange={(event) => onModeChange(event.target.value as TranscriptionMode)}>
                <option value="auto">{zh ? '自动' : 'Auto'}</option>
                <option value="live">{zh ? '实时' : 'Live'}</option>
                <option value="accelerated">{zh ? '极速' : 'Fast'}</option>
              </select>
            </label>
          </div>
          <div className="tunnel-transcript" aria-live="polite">
            {transcriptText}
          </div>
          {monitor ? (
            <div className="tunnel-monitor-note" aria-live="polite">
              <span className="tunnel-state-dot" />
              {zh ? '字幕完成后直接返回 Codex' : 'Returned to Codex when complete'}
            </div>
          ) : (
            <div className="tunnel-output-actions">
              <button className="tunnel-copy" onClick={handleCopy} type="button">{copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制全文' : 'Copy full transcript')}</button>
              <button className="tunnel-secondary" onClick={onClear} type="button">{zh ? '清空' : 'Clear'}</button>
              <button className="tunnel-secondary" onClick={onRetry} type="button">{zh ? '重新转录' : 'Retry'}</button>
            </div>
          )}
        </article>
      </div>

      <div className="tunnel-machine-footnote">
        <span className="footnote-led" />
        <span>{zh ? '目标标签页静音 · 其他声音保持不变' : 'Target tab muted · everything else stays untouched'}</span>
        <span className="footnote-divider" />
        <span>{state === 'failed' ? (zh ? '检查连接后重试' : 'Check the connection and retry') : state === 'completed' ? (zh ? '收录完成' : 'Capture complete') : (zh ? '本机处理' : 'On-device')}</span>
      </div>
    </section>
  );
}
