import { describe, expect, it, vi } from 'vitest';

import { CrossWindowSessionStore } from '../src/cross-window-session.js';

describe('CrossWindowSessionStore', () => {
  it('creates and updates an immutable session snapshot', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
    const store = new CrossWindowSessionStore();
    const created = store.create(42, { title: 'Demo', state: 'detecting' });
    const updated = store.update(created.id, {
      state: 'ready',
      pageEndpoint: { screenX: 120, screenY: 240 },
      targetRect: { x: 10, y: 20, width: 300, height: 180 }
    });

    expect(created.state).toBe('detecting');
    expect(updated.state).toBe('ready');
    expect(updated.updatedAt).toBe(200);
    expect(store.get(created.id)).toEqual(updated);

    updated.pageEndpoint!.screenX = 999;
    expect(store.get(created.id)?.pageEndpoint?.screenX).toBe(120);
    vi.restoreAllMocks();
  });

  it('lists, closes and removes stale sessions', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const store = new CrossWindowSessionStore();
    const oldSession = store.create(1);
    vi.spyOn(Date, 'now').mockReturnValue(40_000);
    const freshSession = store.create(2);
    expect(store.list()).toHaveLength(2);
    expect(store.clearStale(40_000, 30_000)).toBe(1);
    expect(store.get(oldSession.id)).toBeUndefined();
    expect(store.get(freshSession.id)).toBeTruthy();
    store.close(freshSession.id);
    expect(store.list()).toEqual([]);
    vi.restoreAllMocks();
  });

  it('rejects invalid tabs and unknown session ids', () => {
    const store = new CrossWindowSessionStore();
    expect(() => store.create(-1)).toThrow('valid Chrome tab id');
    expect(() => store.update('missing', { state: 'ready' })).toThrow('Unknown cross-window session');
  });
});
