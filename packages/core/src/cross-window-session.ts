import type { VoiceVacErrorCode } from './voice-vac-error.js';

export type CrossWindowState =
  | 'idle'
  | 'dragging'
  | 'detecting'
  | 'ready'
  | 'transcribing'
  | 'paused'
  | 'completed'
  | 'error';

export type CrossWindowPoint = {
  screenX: number;
  screenY: number;
};

export type CrossWindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type CrossWindowSession = {
  id: string;
  tabId: number;
  frameId: number;
  documentId: string;
  dropToken: string;
  state: CrossWindowState;
  errorCode?: VoiceVacErrorCode;
  appEndpoint?: CrossWindowPoint;
  pageEndpoint?: CrossWindowPoint;
  targetRect?: CrossWindowRect;
  title?: string;
  url?: string;
  updatedAt: number;
};

export type CrossWindowSessionPatch = Partial<Omit<
  CrossWindowSession,
  'id' | 'tabId' | 'frameId' | 'documentId' | 'dropToken' | 'updatedAt'
>>;

export type CrossWindowSessionInitial = CrossWindowSessionPatch & Pick<
  CrossWindowSession,
  'frameId' | 'documentId' | 'dropToken'
>;

/**
 * In-memory coordination primitive shared by the desktop renderer, extension
 * bridge, and MCP monitor. It deliberately contains no Node or browser-only
 * dependencies so it can be bundled into all three products.
 */
export class CrossWindowSessionStore {
  private readonly sessions = new Map<string, CrossWindowSession>();
  private sequence = 0;

  create(tabId: number, initial: CrossWindowSessionInitial): CrossWindowSession {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('A valid Chrome tab id is required');
    validateChromeIdentity(initial);
    const session: CrossWindowSession = {
      id: createSessionId(++this.sequence),
      tabId,
      state: 'idle',
      updatedAt: Date.now(),
      ...cloneInitial(initial)
    };
    this.sessions.set(session.id, session);
    return cloneSession(session);
  }

  update(id: string, patch: CrossWindowSessionPatch): CrossWindowSession {
    const current = this.sessions.get(id);
    if (!current) throw new Error(`Unknown cross-window session: ${id}`);
    const next: CrossWindowSession = {
      ...current,
      ...clonePatch(patch),
      id: current.id,
      updatedAt: Date.now()
    };
    this.sessions.set(id, next);
    return cloneSession(next);
  }

  get(id: string): CrossWindowSession | undefined {
    const session = this.sessions.get(id);
    return session ? cloneSession(session) : undefined;
  }

  list(): CrossWindowSession[] {
    return [...this.sessions.values()].map(cloneSession);
  }

  close(id: string): void {
    this.sessions.delete(id);
  }

  clearStale(now = Date.now(), maxAgeMs = 30_000): number {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.updatedAt > maxAgeMs) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

function createSessionId(sequence: number): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `voice-vac-${randomUuid}`;
  return `voice-vac-${Date.now().toString(36)}-${sequence.toString(36)}`;
}

function clonePatch(patch: CrossWindowSessionPatch): CrossWindowSessionPatch {
  return {
    ...(patch.state !== undefined ? { state: patch.state } : {}),
    ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
    ...(patch.appEndpoint ? { appEndpoint: { ...patch.appEndpoint } } : {}),
    ...(patch.pageEndpoint ? { pageEndpoint: { ...patch.pageEndpoint } } : {}),
    ...(patch.targetRect ? { targetRect: { ...patch.targetRect } } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {})
  };
}

function cloneInitial(initial: CrossWindowSessionInitial): CrossWindowSessionInitial {
  return {
    ...clonePatch(initial),
    frameId: initial.frameId,
    documentId: initial.documentId,
    dropToken: initial.dropToken
  };
}

function validateChromeIdentity(initial: CrossWindowSessionInitial): void {
  if (!Number.isSafeInteger(initial.frameId) || initial.frameId < 0) {
    throw new Error('A valid Chrome frame id is required');
  }
  if (!initial.documentId || initial.documentId.trim() !== initial.documentId) {
    throw new Error('A valid Chrome document id is required');
  }
  if (!/^VOICE_VAC_DROP_V1\|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\|[A-Za-z0-9_-]{43}$/iu.test(initial.dropToken)) {
    throw new Error('A valid Voice VAC drop token is required');
  }
}

function cloneSession(session: CrossWindowSession): CrossWindowSession {
  return {
    ...session,
    ...(session.appEndpoint ? { appEndpoint: { ...session.appEndpoint } } : {}),
    ...(session.pageEndpoint ? { pageEndpoint: { ...session.pageEndpoint } } : {}),
    ...(session.targetRect ? { targetRect: { ...session.targetRect } } : {})
  };
}
