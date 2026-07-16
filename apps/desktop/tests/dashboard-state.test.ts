import { describe, expect, it } from 'vitest';

import { deriveCapturePresentation } from '../src/renderer/dashboard-state.js';

describe('capture presentation', () => {
  it('tells the user exactly how to start a silent capture when idle', () => {
    expect(
      deriveCapturePresentation({
        sourceKind: 'chrome-tab',
        sourceLabel: '当前 Chrome 标签页',
        activeSession: undefined
      })
    ).toEqual({
      actionLabel: '在扩展中开始',
      canChangeSource: true,
      notice: '在 Chrome 扩展中点击开始后，只有当前标签页的声音会被发送到本机转写引擎。',
      statusLabel: '准备就绪'
    });
  });

  it('locks the source and makes the stop action explicit during capture', () => {
    expect(
      deriveCapturePresentation({
        sourceKind: 'macos-process',
        sourceLabel: 'Safari',
        activeSession: { id: 'session_1', status: 'capturing' }
      })
    ).toMatchObject({
      actionLabel: '停止收录',
      canChangeSource: false,
      statusLabel: '正在静音收录'
    });
  });
});
