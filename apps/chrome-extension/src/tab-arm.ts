import { formatDropToken } from './drop-protocol.js';
import type { TargetSession } from './target-session.js';
import { TargetSessionStore } from './target-session-store.js';

export type TargetInvalidationCode = 'TAB_CLOSED' | 'TARGET_NAVIGATED';

export class TabArmError extends Error {
  constructor(
    readonly code: 'TAB_NOT_ARMED' | 'TARGET_NAVIGATED',
    message: string
  ) {
    super(message);
    this.name = 'TabArmError';
  }
}

type ArmTab = Pick<chrome.tabs.Tab, 'id' | 'windowId' | 'title' | 'url'>;

export type TabArmDependencies = {
  tabs: {
    query: (query: chrome.tabs.QueryInfo) => Promise<ArmTab[]>;
    sendMessage: (
      tabId: number,
      message: unknown,
      options: { documentId: string; frameId: number }
    ) => Promise<unknown>;
  };
  scripting: {
    executeScript: (details: {
      files: string[];
      target: { tabId: number; frameIds: number[] };
    }) => Promise<Array<{ documentId?: string; frameId: number }>>;
  };
  sessionStore: TargetSessionStore;
  now: () => number;
  randomUUID: () => string;
  randomBytes: (length: number) => Uint8Array;
  beforeReplace?: (previous: TargetSession, next: TargetSession) => Promise<void>;
};

const replacementTails = new WeakMap<TargetSessionStore, Promise<void>>();

export type TargetLifecycleDependencies = {
  tabs: {
    onRemoved: { addListener: (listener: (tabId: number) => void) => void };
    onReplaced: { addListener: (listener: (addedTabId: number, removedTabId: number) => void) => void };
    onUpdated: {
      addListener: (listener: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => void) => void;
    };
  };
  sessionStore: TargetSessionStore;
  stopSession: (session: TargetSession) => Promise<void>;
  disposePlayback: (session: TargetSession) => Promise<void>;
  publishError: (code: TargetInvalidationCode, session: TargetSession) => Promise<void>;
};

export function armActiveTab(deps: TabArmDependencies): Promise<TargetSession> {
  return runSessionTransaction(deps.sessionStore, () => performArmActiveTab(deps));
}

async function performArmActiveTab(deps: TabArmDependencies): Promise<TargetSession> {
  const [tab] = await deps.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.windowId === undefined || !tab.url) {
    throw new TabArmError('TAB_NOT_ARMED', 'The selected Chrome tab is not armed.');
  }

  const [injection] = await deps.scripting.executeScript({
    files: ['content-tunnel.js'],
    target: { tabId: tab.id, frameIds: [0] }
  });
  if (!injection?.documentId || injection.frameId !== 0) {
    throw new TabArmError('TARGET_NAVIGATED', 'The armed page navigated. Arm the current page again.');
  }

  const id = deps.randomUUID();
  const nonce = base64UrlNonce(deps.randomBytes(32));
  const now = deps.now();
  const session: TargetSession = {
    schemaVersion: 1,
    id,
    tabId: tab.id,
    windowId: tab.windowId,
    frameId: 0,
    documentId: injection.documentId,
    pageOrigin: pageOrigin(tab.url),
    url: tab.url,
    title: tab.title?.trim() || 'Chrome video',
    dropNonce: nonce,
    dropToken: formatDropToken(id, nonce),
    status: 'armed',
    armedAt: now,
    updatedAt: now
  };

  const previous = await deps.sessionStore.get();
  if (previous && deps.beforeReplace) await deps.beforeReplace(previous, session);
  await deps.sessionStore.save(session);
  try {
    await deps.tabs.sendMessage(
      tab.id,
      { type: 'session:armed', session },
      { documentId: session.documentId, frameId: session.frameId }
    );
  } catch {
    // The injected Task 4 overlay has no session listener yet. Its document
    // identity is still authoritative; Task 5 adds the authenticated drop listener.
  }
  return session;
}

export function registerTargetLifecycle(deps: TargetLifecycleDependencies): void {
  const enqueue = (tabId: number, code: TargetInvalidationCode): void => {
    void runSessionTransaction(
      deps.sessionStore,
      () => invalidateMatchingSession(deps, tabId, code)
    ).catch(() => undefined);
  };

  deps.tabs.onRemoved.addListener((tabId) => enqueue(tabId, 'TAB_CLOSED'));
  deps.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
    enqueue(removedTabId, 'TARGET_NAVIGATED');
  });
  deps.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
      enqueue(tabId, 'TARGET_NAVIGATED');
    }
  });
}

function runSessionTransaction<T>(
  store: TargetSessionStore,
  operation: () => Promise<T>
): Promise<T> {
  const previous = replacementTails.get(store) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  replacementTails.set(store, result.then(() => undefined, () => undefined));
  return result;
}

async function invalidateMatchingSession(
  deps: TargetLifecycleDependencies,
  tabId: number,
  code: TargetInvalidationCode
): Promise<void> {
  const session = await deps.sessionStore.get();
  if (!session || session.tabId !== tabId) return;

  await Promise.allSettled([
    deps.stopSession(session),
    deps.disposePlayback(session)
  ]);
  try {
    await deps.publishError(code, session);
  } finally {
    await deps.sessionStore.clearIfTab(tabId);
  }
}

function base64UrlNonce(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error('Voice VAC arm nonce must contain exactly 32 bytes.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const nonce = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(nonce)) throw new Error('Voice VAC arm nonce encoding failed.');
  return nonce;
}

function pageOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new TabArmError('TAB_NOT_ARMED', 'The selected Chrome tab is not armable.');
  }
}
