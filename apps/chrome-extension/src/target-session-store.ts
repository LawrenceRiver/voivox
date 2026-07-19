import {
  isTargetSession,
  type TargetSession,
  type TargetSessionPatch
} from './target-session.js';

export const TARGET_SESSION_KEY = 'voiceVacTargetSession.v1';

export type SessionStorage = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

const MUTABLE_PATCH_KEYS = new Set([
  'pageOrigin', 'url', 'title', 'status', 'target', 'updatedAt',
  'lastCommandId', 'tunnelSessionId'
]);

export class TargetSessionStore {
  constructor(
    private readonly storage: SessionStorage = chrome.storage.session,
    private readonly now: () => number = Date.now
  ) {}

  async get(): Promise<TargetSession | undefined> {
    const value = (await this.storage.get(TARGET_SESSION_KEY))[TARGET_SESSION_KEY];
    if (!isTargetSession(value)) {
      if (value !== undefined) await this.storage.remove(TARGET_SESSION_KEY);
      return undefined;
    }
    return structuredClone(value);
  }

  async save(session: TargetSession): Promise<void> {
    if (!isTargetSession(session)) throw new Error('Invalid Voice VAC target session.');
    await this.storage.set({ [TARGET_SESSION_KEY]: structuredClone(session) });
  }

  async update(id: string, patch: TargetSessionPatch): Promise<TargetSession> {
    const current = await this.get();
    if (!current || current.id !== id) throw new Error('Voice VAC target session changed.');
    const patchRecord = patch as Record<string, unknown>;
    if (Object.keys(patchRecord).some((key) => !MUTABLE_PATCH_KEYS.has(key))) {
      throw new Error('Voice VAC target identity is immutable.');
    }
    const next = {
      ...current,
      ...structuredClone(patch),
      updatedAt: this.now()
    };
    if (!isTargetSession(next)) throw new Error('Invalid Voice VAC target session update.');
    await this.save(next);
    return structuredClone(next);
  }

  async clear(): Promise<void> {
    await this.storage.remove(TARGET_SESSION_KEY);
  }

  async clearIfTab(tabId: number): Promise<boolean> {
    const current = await this.get();
    if (!current || current.tabId !== tabId) return false;
    await this.clear();
    return true;
  }
}

export function validateSessionSender(
  session: TargetSession,
  sender: chrome.runtime.MessageSender
): boolean {
  return sender.tab?.id === session.tabId
    && sender.frameId === session.frameId
    && sender.documentId === session.documentId;
}
