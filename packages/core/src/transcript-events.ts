import type { VoiceVacErrorCode } from './voice-vac-error.js';

export const MAX_TRANSCRIPT_WAIT_MS = 25_000;

export type TranscriptStreamStatus =
  | 'capturing'
  | 'complete'
  | 'interrupted'
  | 'failed'
  | 'cancelled';

export type TranscriptFailure = Readonly<{
  code: VoiceVacErrorCode;
  message: string;
  retryable: boolean;
}>;

export type TranscriptStreamSegment = Readonly<{
  startMs: number;
  endMs: number;
  text: string;
}>;

export type TranscriptStreamSnapshot = Readonly<{
  sessionId: string;
  revision: number;
  status: TranscriptStreamStatus;
  rawSegments: readonly TranscriptStreamSegment[];
  failure?: TranscriptFailure;
}>;

export type TranscriptDelta = Readonly<{
  sessionId: string;
  afterRevision: number;
  revision: number;
  status: TranscriptStreamStatus;
  appendedSegments: readonly TranscriptStreamSegment[];
  failure?: TranscriptFailure;
}>;

export type TranscriptWaitOptions = Readonly<{
  signal?: AbortSignal;
  waitMs?: number;
}>;

type JournalEntry = Readonly<{
  revision: number;
  appendedSegments: readonly TranscriptStreamSegment[];
}>;

type Waiter = {
  afterRevision: number;
  resolve: (delta: TranscriptDelta | undefined) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

type StreamState = {
  snapshot: TranscriptStreamSnapshot;
  journal: JournalEntry[];
  waiters: Set<Waiter>;
};

export class TranscriptEventStream {
  private readonly states = new Map<string, StreamState>();
  private readonly maximumJournalEntries: number;

  constructor(options: { maximumJournalEntries?: number } = {}) {
    const maximum = options.maximumJournalEntries ?? 256;
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      throw new Error('Transcript journal capacity must be a positive integer.');
    }
    this.maximumJournalEntries = maximum;
  }

  seed(snapshot: TranscriptStreamSnapshot): void {
    validateSnapshot(snapshot);
    const previous = this.states.get(snapshot.sessionId);
    if (previous) {
      for (const waiter of previous.waiters) {
        this.finishWaiter(previous, waiter, undefined, abortError('Transcript stream was replaced.'));
      }
    }
    const reconstructedJournal: JournalEntry[] = snapshot.rawSegments.map((segment, index) => ({
      revision: index + 1,
      appendedSegments: copySegments([segment])
    }));
    if (snapshot.revision > snapshot.rawSegments.length) {
      reconstructedJournal.push({ revision: snapshot.revision, appendedSegments: [] });
    }
    this.states.set(snapshot.sessionId, {
      snapshot: copySnapshot(snapshot),
      journal: reconstructedJournal.slice(-this.maximumJournalEntries),
      waiters: new Set()
    });
  }

  publish(
    snapshot: TranscriptStreamSnapshot,
    appendedSegments: readonly TranscriptStreamSegment[] = []
  ): void {
    validateSnapshot(snapshot);
    const state = this.requireState(snapshot.sessionId);
    if (snapshot.revision !== state.snapshot.revision + 1) {
      throw new Error('Transcript revisions must advance exactly once.');
    }
    state.snapshot = copySnapshot(snapshot);
    state.journal.push({
      revision: snapshot.revision,
      appendedSegments: copySegments(appendedSegments)
    });
    if (state.journal.length > this.maximumJournalEntries) {
      state.journal.splice(0, state.journal.length - this.maximumJournalEntries);
    }

    for (const waiter of [...state.waiters]) {
      if (snapshot.revision > waiter.afterRevision) {
        this.finishWaiter(
          state,
          waiter,
          this.changesSince(snapshot.sessionId, waiter.afterRevision)
        );
      }
    }
  }

  changesSince(sessionId: string, afterRevision: number): TranscriptDelta {
    validateRevision(afterRevision, 'afterRevision');
    const state = this.requireState(sessionId);
    const current = state.snapshot;
    if (afterRevision > current.revision) {
      throw new Error('Transcript cursor cannot be newer than the session revision.');
    }

    let appendedSegments: readonly TranscriptStreamSegment[] = [];
    if (afterRevision < current.revision) {
      const oldestRevision = state.journal[0]?.revision;
      const journalCoversCursor = oldestRevision !== undefined
        && afterRevision >= oldestRevision - 1;
      appendedSegments = journalCoversCursor
        ? state.journal
            .filter((entry) => entry.revision > afterRevision)
            .flatMap((entry) => copySegments(entry.appendedSegments))
        : copySegments(current.rawSegments.slice(
            Math.min(afterRevision, current.rawSegments.length)
          ));
    }

    return {
      sessionId,
      afterRevision,
      revision: current.revision,
      status: current.status,
      appendedSegments,
      ...(current.failure ? { failure: { ...current.failure } } : {})
    };
  }

  waitForChange(
    sessionId: string,
    afterRevision: number,
    options: TranscriptWaitOptions = {}
  ): Promise<TranscriptDelta | undefined> {
    const initial = this.changesSince(sessionId, afterRevision);
    if (initial.revision > afterRevision) {
      return Promise.resolve(initial);
    }
    if (options.signal?.aborted) {
      return Promise.reject(abortError());
    }
    const requestedWait = options.waitMs ?? MAX_TRANSCRIPT_WAIT_MS;
    if (!Number.isFinite(requestedWait) || requestedWait <= 0) {
      throw new Error('Transcript wait must be a positive duration.');
    }
    const waitMs = Math.min(requestedWait, MAX_TRANSCRIPT_WAIT_MS);
    const state = this.requireState(sessionId);

    return new Promise<TranscriptDelta | undefined>((resolve, reject) => {
      const waiter: Waiter = { afterRevision, resolve, reject };
      if (options.signal) {
        waiter.signal = options.signal;
        waiter.abortListener = () => this.finishWaiter(state, waiter, undefined, abortError());
        options.signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      state.waiters.add(waiter);

      // Re-check after registration. This preserves correctness if publication
      // is ever moved behind an async storage boundary.
      const registered = this.changesSince(sessionId, afterRevision);
      if (registered.revision > afterRevision) {
        this.finishWaiter(state, waiter, registered);
        return;
      }
      waiter.timer = setTimeout(() => this.finishWaiter(state, waiter, undefined), waitMs);
    });
  }

  private requireState(sessionId: string): StreamState {
    const state = this.states.get(sessionId);
    if (!state) {
      throw new Error(`Unknown transcript session ${sessionId}`);
    }
    return state;
  }

  private finishWaiter(
    state: StreamState,
    waiter: Waiter,
    delta?: TranscriptDelta,
    error?: Error
  ): void {
    if (!state.waiters.delete(waiter)) {
      return;
    }
    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
    }
    if (error) {
      waiter.reject(error);
    } else {
      waiter.resolve(delta);
    }
  }
}

function validateSnapshot(snapshot: TranscriptStreamSnapshot): void {
  if (!snapshot.sessionId) {
    throw new Error('Transcript session id is required.');
  }
  validateRevision(snapshot.revision, 'revision');
  if (snapshot.revision < snapshot.rawSegments.length) {
    throw new Error('Transcript revision cannot precede its published segments.');
  }
}

function validateRevision(revision: number, label: string): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`Transcript ${label} must be a nonnegative integer.`);
  }
}

function copySnapshot(snapshot: TranscriptStreamSnapshot): TranscriptStreamSnapshot {
  return {
    ...snapshot,
    rawSegments: copySegments(snapshot.rawSegments),
    ...(snapshot.failure ? { failure: { ...snapshot.failure } } : {})
  };
}

function copySegments(
  segments: readonly TranscriptStreamSegment[]
): TranscriptStreamSegment[] {
  return segments.map((segment) => ({ ...segment }));
}

function abortError(message = 'Transcript wait was aborted.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
