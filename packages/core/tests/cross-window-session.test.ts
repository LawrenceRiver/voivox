import { describe, expect, it, vi } from 'vitest';

import { CrossWindowSessionStore } from '../src/cross-window-session.js';

describe('CrossWindowSessionStore', () => {
  it('creates and updates an immutable session snapshot', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(200);
    const store = new CrossWindowSessionStore();
    const created = store.create(42, {
      frameId: 0,
      documentId: 'doc-42',
      dropToken: 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      title: 'Demo',
      state: 'detecting'
    });
    const updated = store.update(created.id, {
      errorCode: 'TARGET_NAVIGATED',
      state: 'ready',
      pageEndpoint: { screenX: 120, screenY: 240 },
      targetRect: { x: 10, y: 20, width: 300, height: 180 }
    });

    expect(created.state).toBe('detecting');
    expect(created).toMatchObject({ tabId: 42, frameId: 0, documentId: 'doc-42' });
    expect(updated.state).toBe('ready');
    expect(updated.errorCode).toBe('TARGET_NAVIGATED');
    expect(updated.updatedAt).toBe(200);
    expect(store.get(created.id)).toEqual(updated);

    updated.pageEndpoint!.screenX = 999;
    expect(store.get(created.id)?.pageEndpoint?.screenX).toBe(120);
    vi.restoreAllMocks();
  });

  it('lists, closes and removes stale sessions', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const store = new CrossWindowSessionStore();
    const oldSession = store.create(1, chromeIdentity('doc-1'));
    vi.spyOn(Date, 'now').mockReturnValue(40_000);
    const freshSession = store.create(2, chromeIdentity('doc-2'));
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
    expect(() => store.create(-1, chromeIdentity('doc-invalid'))).toThrow('valid Chrome tab id');
    expect(() => store.update('missing', { state: 'ready' })).toThrow('Unknown cross-window session');
  });

  it('never lets a patch retarget the armed Chrome document or drop token', () => {
    const store = new CrossWindowSessionStore();
    const created = store.create(42, {
      frameId: 0,
      documentId: 'doc-42',
      dropToken: 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    });

    const updated = store.update(created.id, {
      tabId: 99,
      frameId: 7,
      documentId: 'doc-99',
      dropToken: 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      state: 'ready'
    } as never);

    expect(updated).toMatchObject({
      tabId: 42,
      frameId: 0,
      documentId: 'doc-42',
      dropToken: created.dropToken,
      state: 'ready'
    });
    expect(store.update(created.id, { unexpected: 'ignored' } as never)).not.toHaveProperty('unexpected');
  });

  it('rejects malformed supplied Chrome document identities', () => {
    const store = new CrossWindowSessionStore();
    expect(() => store.create(1, { ...chromeIdentity('doc-1'), frameId: -1 })).toThrow('frame id');
    expect(() => store.create(1, { ...chromeIdentity('doc-1'), documentId: '' })).toThrow('document id');
    expect(() => store.create(1, { ...chromeIdentity('doc-1'), dropToken: 'not-a-drop-token' })).toThrow('drop token');
  });
});

function chromeIdentity(documentId: string) {
  return {
    frameId: 0,
    documentId,
    dropToken: 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  };
}
