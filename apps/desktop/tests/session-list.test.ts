import { describe, expect, it } from 'vitest';

import { localizedSessionSourceLabel, sessionStatusLabel } from '../src/renderer/session-list.js';

describe('desktop session labels', () => {
  it('localizes generic Chrome sources without changing app names', () => {
    expect(localizedSessionSourceLabel('en', {
      kind: 'chrome-tab',
      label: '当前 Chrome 标签页'
    })).toBe('Chrome tab');
    expect(localizedSessionSourceLabel('en', {
      kind: 'macos-process',
      label: 'Spotify',
      processId: 42
    })).toBe('Spotify');
    expect(localizedSessionSourceLabel('en', {
      kind: 'chrome-tab',
      label: 'My music video · Xiaohongshu'
    })).toBe('My music video · Xiaohongshu');
  });

  it('does not describe an interrupted session as complete', () => {
    expect(sessionStatusLabel('zh-CN', 'interrupted')).toBe('收录已中断');
    expect(sessionStatusLabel('en', 'interrupted')).toBe('Capture interrupted');
  });
});
