import { describe, expect, it } from 'vitest';

import { deriveCapturePresentation } from '../src/renderer/dashboard-state.js';

describe('capture presentation', () => {
  it('tells the user exactly how to start a silent capture when idle', () => {
    expect(
      deriveCapturePresentation({
        sourceKind: 'chrome-tab',
        sourceLabel: '当前 Chrome 标签页',
        activeSession: undefined
      }, 'zh-CN')
    ).toEqual({
      actionLabel: '在 Chrome 扩展中开始',
      canChangeSource: true,
      notice: '扩展只把目标标签页的音频送入本机 Voice VAC App，再由 Qwen3-ASR 转写。',
      statusLabel: '准备就绪'
    });
  });

  it('returns the same capture state in English', () => {
    expect(
      deriveCapturePresentation({
        sourceKind: 'chrome-tab',
        sourceLabel: 'Current Chrome tab',
        activeSession: undefined
      }, 'en')
    ).toMatchObject({
      actionLabel: 'Start in the Chrome extension',
      notice: 'The extension sends only the target tab audio to the local Voice VAC App for Qwen3-ASR transcription.',
      statusLabel: 'Ready'
    });
  });

  it('locks the source and makes the stop action explicit during capture', () => {
    expect(
      deriveCapturePresentation({
        sourceKind: 'macos-process',
        sourceLabel: 'Safari',
        activeSession: { id: 'session_1', status: 'capturing' }
      }, 'zh-CN')
    ).toMatchObject({
      actionLabel: '停止收录',
      canChangeSource: false,
      statusLabel: '正在静音收录'
    });
  });
});
