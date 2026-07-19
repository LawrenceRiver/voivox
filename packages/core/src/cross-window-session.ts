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
  state: CrossWindowState;
  appEndpoint?: CrossWindowPoint;
  pageEndpoint?: CrossWindowPoint;
  targetRect?: CrossWindowRect;
  title?: string;
  url?: string;
  updatedAt: number;
};

export type CrossWindowSessionPatch = Partial<Omit<CrossWindowSession, 'id' | 'updatedAt'>>;

/**
 * In-memory coordination primitive shared by the desktop renderer, extension
 * bridge, and MCP monitor. It deliberately contains no Node or browser-only
 * dependencies so it can be bundled into all three products.
 */
export class CrossWindowSessionStore {
  private readonly sessions = new Map<string, CrossWindowSession>();
  private sequence = 0;

  create(tabId: number, initial: CrossWindowSessionPatch = {}): CrossWindowSession {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('A valid Chrome tab id is required');
    const session: CrossWindowSession = {
      id: createSessionId(++this.sequence),
      tabId,
      state: 'idle',
      updatedAt: Date.now(),
      ...clonePatch(initial)
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
    ...patch,
    ...(patch.appEndpoint ? { appEndpoint: { ...patch.appEndpoint } } : {}),
    ...(patch.pageEndpoint ? { pageEndpoint: { ...patch.pageEndpoint } } : {}),
    ...(patch.targetRect ? { targetRect: { ...patch.targetRect } } : {})
  };
}

function cloneSession(session: CrossWindowSession): CrossWindowSession {
  return {
    ...session,
    ...(session.appEndpoint ? { appEndpoint: { ...session.appEndpoint } } : {}),
    ...(session.pageEndpoint ? { pageEndpoint: { ...session.pageEndpoint } } : {}),
    ...(session.targetRect ? { targetRect: { ...session.targetRect } } : {})
  };
}
