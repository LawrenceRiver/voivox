import { describe, expect, it } from 'vitest';

import {
  TargetSessionStore,
  validateSessionSender,
  type SessionStorage
} from '../src/target-session-store.js';
import type { TargetSession } from '../src/target-session.js';

function armedSession(overrides: Partial<TargetSession> = {}): TargetSession {
  return {
    schemaVersion: 1,
    id: '2b0fe529-4021-4674-b55e-1cf081f947dd',
    tabId: 17,
    windowId: 3,
    frameId: 0,
    documentId: 'doc-A',
    pageOrigin: 'https://video.example',
    url: 'https://video.example/watch',
    title: 'Target video',
    dropNonce: 'AbCdEf0123_-nonce',
    dropToken: 'VOICE_VAC_DROP_V1|session|nonce',
    status: 'armed',
    armedAt: 100,
    updatedAt: 100,
    ...overrides
  };
}

function memorySessionStorage(initial?: unknown): SessionStorage & { dump: () => Record<string, unknown> } {
  let values: Record<string, unknown> = initial === undefined
    ? {}
    : { 'voiceVacTargetSession.v1': initial };
  return {
    async get(key) {
      return { [key]: values[key] };
    },
    async set(items) {
      values = { ...values, ...structuredClone(items) };
    },
    async remove(key) {
      delete values[key];
    },
    dump: () => structuredClone(values)
  };
}

describe('TargetSessionStore', () => {
  it('stores one armed document in session storage and returns clones', async () => {
    const storage = memorySessionStorage();
    const store = new TargetSessionStore(storage, () => 150);
    const session = armedSession();
    await store.save(session);

    const first = await store.get();
    expect(first).toMatchObject({ tabId: 17, frameId: 0, documentId: 'doc-A' });
    if (!first) throw new Error('missing test session');
    first.title = 'mutated outside store';
    expect((await store.get())?.title).toBe('Target video');
    expect(storage.dump()).toHaveProperty('voiceVacTargetSession.v1');
  });

  it('updates only a matching session and preserves immutable target identity', async () => {
    const storage = memorySessionStorage(armedSession());
    const store = new TargetSessionStore(storage, () => 200);

    const updated = await store.update(armedSession().id, {
      status: 'ready',
      title: 'Ready video',
      tunnelSessionId: 'tunnel-1'
    });

    expect(updated).toMatchObject({
      tabId: 17,
      documentId: 'doc-A',
      dropToken: armedSession().dropToken,
      status: 'ready',
      title: 'Ready video',
      updatedAt: 200
    });
    await expect(store.update('00000000-0000-4000-8000-000000000000', { status: 'ready' }))
      .rejects.toThrow('target session changed');
    await expect(store.update(armedSession().id, {
      tabId: 99,
      documentId: 'doc-retargeted'
    } as never)).rejects.toThrow('target identity is immutable');
    expect(await store.get()).toMatchObject({ tabId: 17, documentId: 'doc-A' });
  });

  it('removes malformed stored data instead of coercing it', async () => {
    for (const invalid of [
      { ...armedSession(), schemaVersion: '1' },
      { ...armedSession(), tabId: 17.5 },
      { ...armedSession(), documentId: '' },
      { ...armedSession(), status: 'unknown' },
      { ...armedSession(), target: { kind: 'video' } },
      { ...armedSession(), unexpected: true }
    ]) {
      const storage = memorySessionStorage(invalid);
      const store = new TargetSessionStore(storage);
      await expect(store.get()).resolves.toBeUndefined();
      expect(storage.dump()).not.toHaveProperty('voiceVacTargetSession.v1');
    }
  });

  it('clears only the matching tab', async () => {
    const storage = memorySessionStorage(armedSession());
    const store = new TargetSessionStore(storage);

    await expect(store.clearIfTab(99)).resolves.toBe(false);
    expect(await store.get()).toBeDefined();
    await expect(store.clearIfTab(17)).resolves.toBe(true);
    expect(await store.get()).toBeUndefined();
  });

  it('rejects the right tab with the wrong document or frame', () => {
    const session = armedSession();
    expect(validateSessionSender(session, {
      tab: { id: 17 }, frameId: 0, documentId: 'doc-A'
    } as chrome.runtime.MessageSender)).toBe(true);
    expect(validateSessionSender(session, {
      tab: { id: 17 }, frameId: 0, documentId: 'doc-B'
    } as chrome.runtime.MessageSender)).toBe(false);
    expect(validateSessionSender(session, {
      tab: { id: 17 }, frameId: 1, documentId: 'doc-A'
    } as chrome.runtime.MessageSender)).toBe(false);
  });

  it('is physically implemented on chrome.storage.session, never local storage', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile(new URL('../src/target-session-store.ts', import.meta.url), 'utf8'));
    expect(source).toContain('chrome.storage.session');
    expect(source).not.toContain('chrome.storage.local');
  });
});
