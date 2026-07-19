import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  armActiveTab,
  registerTargetLifecycle,
  type TabArmDependencies,
  type TargetLifecycleDependencies
} from '../src/tab-arm.js';
import {
  TargetSessionStore,
  type SessionStorage
} from '../src/target-session-store.js';
import type { TargetSession } from '../src/target-session.js';

const SESSION_ID = '2b0fe529-4021-4674-b55e-1cf081f947dd';
const NONCE_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('armActiveTab', () => {
  it('is invoked by the popup arm message instead of the legacy overlay message', async () => {
    const source = await readFile(new URL('../src/popup.ts', import.meta.url), 'utf8');
    expect(source).toContain("type: 'tab:arm'");
    expect(source).not.toContain("type: 'overlay:show'");
  });

  it('keeps the sole active-tab query inside tab-arm', async () => {
    const worker = await readFile(new URL('../src/service-worker-core.ts', import.meta.url), 'utf8');
    expect(worker).not.toContain('chrome.tabs.query');
  });

  it('looks up the active tab once and keeps the armed document after focus changes', async () => {
    const harness = createTabArmHarness();

    const session = await armActiveTab(harness.dependencies);
    harness.setActiveTab({
      id: 99,
      windowId: 3,
      title: 'Other',
      url: 'https://other.example/'
    });

    expect(session).toMatchObject({
      tabId: 41,
      frameId: 0,
      documentId: 'doc-41',
      status: 'armed'
    });
    expect((await harness.sessionStore.get())?.tabId).toBe(41);
    expect(harness.queryCalls()).toBe(1);
    expect(harness.sentMessages).toEqual([{
      message: { type: 'session:armed', session },
      options: { documentId: 'doc-41', frameId: 0 },
      tabId: 41
    }]);
  });

  it('uses 32 random bytes and the exact temporary drop-token format', async () => {
    const harness = createTabArmHarness();

    const session = await armActiveTab(harness.dependencies);

    expect(harness.randomByteLengths).toEqual([32]);
    expect(session.dropNonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(session.dropToken).toBe(`VOICE_VAC_DROP_V1|${SESSION_ID}|${session.dropNonce}`);
  });

  it('fails closed when there is no armable active tab', async () => {
    const harness = createTabArmHarness({ activeTab: undefined });

    await expect(armActiveTab(harness.dependencies)).rejects.toMatchObject({ code: 'TAB_NOT_ARMED' });
    expect(await harness.sessionStore.get()).toBeUndefined();
  });

  it('fails closed when injection does not identify the main-frame document', async () => {
    for (const injection of [undefined, { documentId: '', frameId: 0 }, { documentId: 'doc-41', frameId: 1 }]) {
      const harness = createTabArmHarness({ injection });

      await expect(armActiveTab(harness.dependencies)).rejects.toMatchObject({ code: 'TARGET_NAVIGATED' });
      expect(await harness.sessionStore.get()).toBeUndefined();
    }
  });

  it('does not start capture, playback, or an offscreen document while arming', async () => {
    const harness = createTabArmHarness();

    await armActiveTab(harness.dependencies);

    expect(Object.keys(harness.dependencies)).toEqual([
      'tabs', 'scripting', 'sessionStore', 'now', 'randomUUID', 'randomBytes'
    ]);
  });

  it('runs replacement teardown before publishing the new armed session', async () => {
    const harness = createTabArmHarness();
    const old = armedSession();
    await harness.sessionStore.save(old);
    const order: string[] = [];
    (harness.dependencies as TabArmDependencies & {
      beforeReplace: (session: TargetSession) => Promise<void>;
    }).beforeReplace = async (session) => {
      expect(session).toEqual(old);
      order.push('stop', 'dispose', 'bridge-error');
      expect((await harness.sessionStore.get())?.id).toBe(old.id);
    };

    const next = await armActiveTab(harness.dependencies);
    order.push('published');

    expect(order).toEqual(['stop', 'dispose', 'bridge-error', 'published']);
    expect((await harness.sessionStore.get())?.id).toBe(next.id);
  });

  it('keeps the old identity when replacement teardown fails', async () => {
    const harness = createTabArmHarness();
    const old = armedSession();
    await harness.sessionStore.save(old);
    (harness.dependencies as TabArmDependencies & {
      beforeReplace: () => Promise<void>;
    }).beforeReplace = async () => { throw new Error('old bridge did not terminate'); };

    await expect(armActiveTab(harness.dependencies)).rejects.toThrow('old bridge did not terminate');

    expect(await harness.sessionStore.get()).toEqual(old);
    expect(harness.sentMessages).toEqual([]);
  });

  it('serializes concurrent replacement transactions for the same store', async () => {
    const harness = createTabArmHarness();
    await harness.sessionStore.save(armedSession());
    let activeReplacements = 0;
    let maximumConcurrent = 0;
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = () => resolve(); });
    let replacementCount = 0;
    (harness.dependencies as TabArmDependencies & {
      beforeReplace: () => Promise<void>;
    }).beforeReplace = async () => {
      replacementCount += 1;
      activeReplacements += 1;
      maximumConcurrent = Math.max(maximumConcurrent, activeReplacements);
      if (replacementCount === 1) await firstGate;
      activeReplacements -= 1;
    };

    const first = armActiveTab(harness.dependencies);
    await flushMicrotasks();
    harness.setActiveTab({ id: 42, windowId: 3, title: 'Second', url: 'https://second.example/' });
    const second = armActiveTab(harness.dependencies);
    await flushMicrotasks();

    expect(maximumConcurrent).toBe(1);
    expect(harness.queryCalls()).toBe(1);
    releaseFirst();
    const [firstSession, secondSession] = await Promise.all([first, second]);
    expect(firstSession.tabId).toBe(41);
    expect(secondSession.tabId).toBe(42);
    expect((await harness.sessionStore.get())?.tabId).toBe(42);
  });

  it('queues navigation invalidation behind a replacement and cannot publish a stale new session', async () => {
    const harness = createTabArmHarness();
    await harness.sessionStore.save(armedSession());
    let onUpdated: ((tabId: number, change: chrome.tabs.TabChangeInfo) => void) | undefined;
    const errors: string[] = [];
    registerTargetLifecycle({
      tabs: {
        onRemoved: { addListener: () => undefined },
        onReplaced: { addListener: () => undefined },
        onUpdated: { addListener: (listener) => { onUpdated = listener; } }
      },
      sessionStore: harness.sessionStore,
      stopSession: async () => undefined,
      disposePlayback: async () => undefined,
      publishError: async (code) => { errors.push(code); }
    });
    let replacementStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { replacementStarted = () => resolve(); });
    let releaseReplacement: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseReplacement = () => resolve(); });
    harness.dependencies.beforeReplace = async () => {
      replacementStarted();
      await gate;
    };

    const arming = armActiveTab(harness.dependencies);
    await started;
    onUpdated?.(41, { status: 'loading' });
    releaseReplacement();
    await arming;
    await flushMicrotasks();

    expect(await harness.sessionStore.get()).toBeUndefined();
    expect(errors).toEqual(['TARGET_NAVIGATED']);
  });
});

describe('registerTargetLifecycle', () => {
  it.each([
    ['removed', 'TAB_CLOSED'],
    ['replaced', 'TARGET_NAVIGATED'],
    ['loading', 'TARGET_NAVIGATED'],
    ['url', 'TARGET_NAVIGATED']
  ] as const)('invalidates the matching session on %s', async (event, expectedCode) => {
    const harness = createLifecycleHarness(armedSession());
    registerTargetLifecycle(harness.dependencies);

    harness.emit(event, 41);
    await flushMicrotasks();

    expect(await harness.sessionStore.get()).toBeUndefined();
    expect(harness.stopped).toEqual([armedSession().id]);
    expect(harness.disposed).toEqual([armedSession().id]);
    expect(harness.errors).toEqual([{ code: expectedCode, session: armedSession() }]);
  });

  it('ignores lifecycle events for every other tab', async () => {
    const harness = createLifecycleHarness(armedSession());
    registerTargetLifecycle(harness.dependencies);

    for (const event of ['removed', 'replaced', 'loading', 'url'] as const) harness.emit(event, 99);
    await flushMicrotasks();

    expect(await harness.sessionStore.get()).toEqual(armedSession());
    expect(harness.stopped).toEqual([]);
    expect(harness.disposed).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it('does not invalidate on an unrelated update for the matching tab', async () => {
    const harness = createLifecycleHarness(armedSession());
    registerTargetLifecycle(harness.dependencies);

    harness.emit('complete', 41);
    await flushMicrotasks();

    expect(await harness.sessionStore.get()).toEqual(armedSession());
  });
});

function createTabArmHarness(overrides: {
  activeTab?: chrome.tabs.Tab;
  injection?: { documentId?: string; frameId: number };
} = {}): {
  dependencies: TabArmDependencies;
  queryCalls: () => number;
  randomByteLengths: number[];
  sentMessages: Array<Record<string, unknown>>;
  sessionStore: TargetSessionStore;
  setActiveTab: (tab: Pick<chrome.tabs.Tab, 'id' | 'windowId' | 'title' | 'url'> | undefined) => void;
} {
  let activeTab: Pick<chrome.tabs.Tab, 'id' | 'windowId' | 'title' | 'url'> | undefined = Object.hasOwn(overrides, 'activeTab')
    ? overrides.activeTab
    : { id: 41, windowId: 3, title: 'Target', url: 'https://video.example/watch' };
  const injection = Object.hasOwn(overrides, 'injection')
    ? overrides.injection
    : { documentId: 'doc-41', frameId: 0 };
  const storage = memorySessionStorage();
  const sessionStore = new TargetSessionStore(storage, () => 1_000);
  let queryCalls = 0;
  const sentMessages: Array<Record<string, unknown>> = [];
  const randomByteLengths: number[] = [];
  const dependencies: TabArmDependencies = {
    tabs: {
      query: async (query) => {
        expect(query).toEqual({ active: true, currentWindow: true });
        queryCalls += 1;
        return activeTab ? [activeTab] : [];
      },
      sendMessage: async (tabId, message, options) => {
        sentMessages.push({ tabId, message, options });
        return undefined;
      }
    },
    scripting: {
      executeScript: async (details) => {
        expect(details).toEqual({
          files: ['content-tunnel.js'],
          target: { tabId: activeTab?.id, frameIds: [0] }
        });
        return injection ? [injection] : [];
      }
    },
    sessionStore,
    now: () => 1_000,
    randomUUID: () => SESSION_ID,
    randomBytes: (length) => {
      randomByteLengths.push(length);
      return NONCE_BYTES;
    }
  };
  return {
    dependencies,
    queryCalls: () => queryCalls,
    randomByteLengths,
    sentMessages,
    sessionStore,
    setActiveTab: (tab) => { activeTab = tab; }
  };
}

function createLifecycleHarness(initial: TargetSession): {
  dependencies: TargetLifecycleDependencies;
  disposed: string[];
  emit: (event: 'removed' | 'replaced' | 'loading' | 'url' | 'complete', tabId: number) => void;
  errors: Array<{ code: string; session: TargetSession }>;
  sessionStore: TargetSessionStore;
  stopped: string[];
} {
  const listeners: {
    removed?: (tabId: number) => void;
    replaced?: (addedTabId: number, removedTabId: number) => void;
    updated?: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void;
  } = {};
  const sessionStore = new TargetSessionStore(memorySessionStorage(initial), () => 2_000);
  const stopped: string[] = [];
  const disposed: string[] = [];
  const errors: Array<{ code: string; session: TargetSession }> = [];
  return {
    dependencies: {
      tabs: {
        onRemoved: { addListener: (listener) => { listeners.removed = listener; } },
        onReplaced: { addListener: (listener) => { listeners.replaced = listener; } },
        onUpdated: { addListener: (listener) => { listeners.updated = listener; } }
      },
      sessionStore,
      stopSession: async (session) => { stopped.push(session.id); },
      disposePlayback: async (session) => { disposed.push(session.id); },
      publishError: async (code, session) => { errors.push({ code, session }); }
    },
    disposed,
    emit(event, tabId) {
      if (event === 'removed') listeners.removed?.(tabId);
      if (event === 'replaced') listeners.replaced?.(tabId + 1, tabId);
      if (event === 'loading') listeners.updated?.(tabId, { status: 'loading' });
      if (event === 'url') listeners.updated?.(tabId, { url: 'https://next.example/' });
      if (event === 'complete') listeners.updated?.(tabId, { status: 'complete' });
    },
    errors,
    sessionStore,
    stopped
  };
}

function armedSession(): TargetSession {
  const nonce = Buffer.from(NONCE_BYTES).toString('base64url');
  return {
    schemaVersion: 1,
    id: SESSION_ID,
    tabId: 41,
    windowId: 3,
    frameId: 0,
    documentId: 'doc-41',
    pageOrigin: 'https://video.example',
    url: 'https://video.example/watch',
    title: 'Target',
    dropNonce: nonce,
    dropToken: `VOICE_VAC_DROP_V1|${SESSION_ID}|${nonce}`,
    status: 'armed',
    armedAt: 1_000,
    updatedAt: 1_000
  };
}

function memorySessionStorage(initial?: TargetSession): SessionStorage {
  let value = initial ? structuredClone(initial) : undefined;
  return {
    async get(key) { return { [key]: value }; },
    async set(items) { value = structuredClone(items['voiceVacTargetSession.v1']) as TargetSession; },
    async remove() { value = undefined; }
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
