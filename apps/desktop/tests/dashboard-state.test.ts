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
      notice: '扩展始终在浏览器本地转写；App 打开时只自动保存完成的文字。',
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
      notice: 'The extension always transcribes in the browser. When the App is open, only completed text is saved automatically.',
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
