import { createTranscriptResult, type ProcessingMode, type TranscriptResult } from './pvtt-contract.js';
import type { SessionStore } from './session-store.js';
import {
  TranscriptEventStream,
  type TranscriptDelta,
  type TranscriptFailure,
  type TranscriptStreamSnapshot,
  type TranscriptStreamStatus,
  type TranscriptWaitOptions
} from './transcript-events.js';

export type { TranscriptDelta, TranscriptFailure, TranscriptWaitOptions } from './transcript-events.js';

export type CaptureSource = {
  kind: 'chrome-tab' | 'macos-process' | 'microphone';
  label: string;
  processId?: number;
  title?: string;
  url?: string;
  language?: string;
};

export type ActiveVideoTranscriptionOptions = {
  mode: 'auto' | 'live' | 'accelerated';
  language: string;
  timestamps: boolean;
  output_format: 'text' | 'json' | 'srt' | 'vtt';
};

export type RawSegment = {
  startMs: number;
  endMs: number;
  text: string;
};

export type DerivedTranscript = {
  provider: string;
  instruction: string;
  text: string;
};

export type CaptureStatus = TranscriptStreamStatus;

export type CaptureSession = {
  id: string;
  revision: number;
  source: CaptureSource;
  status: CaptureStatus;
  createdAt: string;
  stoppedAt?: string;
  rawSegments: RawSegment[];
  derivedTranscripts: DerivedTranscript[];
  processingMode?: ProcessingMode;
  failure?: TranscriptFailure;
};

export class VoivoxService {
  private readonly sessions = new Map<string, CaptureSession>();
  private activeSessionId: string | undefined;
  private nextId = 1;
  private readonly transcriptEvents = new TranscriptEventStream();

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly store?: SessionStore
  ) {
    const recoveredSessions = store?.load() ?? [];
    let didRecoverInterruptedSession = false;

    for (const recovered of recoveredSessions) {
      const session = this.normalizeRecoveredSession(recovered);
      if (session.status === 'capturing') {
        session.status = 'interrupted';
        session.stoppedAt = this.clock().toISOString();
        session.revision += 1;
        didRecoverInterruptedSession = true;
      }
      this.sessions.set(session.id, session);
      this.transcriptEvents.seed(this.streamSnapshot(session));
      this.nextId = Math.max(this.nextId, numericId(session.id) + 1);
    }

    if (didRecoverInterruptedSession) {
      this.persist();
    }
  }

  startCapture(source: CaptureSource): CaptureSession {
    if (this.activeSessionId) {
      throw new Error('Voice Vac is already capturing another source.');
    }

    const session: CaptureSession = {
      id: `session_${this.nextId}`,
      revision: 0,
      source,
      status: 'capturing',
      createdAt: this.clock().toISOString(),
      rawSegments: [],
      derivedTranscripts: []
    };

    this.persistWith(session);
    this.nextId += 1;
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    this.transcriptEvents.seed(this.streamSnapshot(session));
    return this.copySession(session);
  }

  appendRawSegment(sessionId: string, segment: RawSegment): void {
    const session = this.requireSession(sessionId);

    if (session.status !== 'capturing') {
      const status = session.status === 'complete' ? 'completed' : session.status;
      throw new Error(`Cannot append transcript to ${status} session ${sessionId}`);
    }

    const validated = validateSegment(segment, session.rawSegments.at(-1));
    const next: CaptureSession = {
      ...this.copySession(session),
      revision: session.revision + 1,
      rawSegments: [...session.rawSegments.map((entry) => ({ ...entry })), validated]
    };
    this.commitSession(next, [validated]);
  }

  stopCapture(sessionId: string): CaptureSession {
    const session = this.requireSession(sessionId);
    if (session.status === 'complete') {
      return this.copySession(session);
    }
    return this.terminalTransition(session, 'complete');
  }

  failCapture(sessionId: string, failure: TranscriptFailure): CaptureSession {
    const session = this.requireSession(sessionId);
    if (session.status === 'failed') {
      return this.copySession(session);
    }
    return this.terminalTransition(session, 'failed', validateFailure(failure));
  }

  cancelCapture(sessionId: string): CaptureSession {
    const session = this.requireSession(sessionId);
    if (session.status === 'cancelled') {
      return this.copySession(session);
    }
    return this.terminalTransition(session, 'cancelled', {
      code: 'TRANSCRIPTION_CANCELLED',
      message: 'The transcription was cancelled.',
      retryable: false
    });
  }

  importCompletedCapture(
    source: CaptureSource,
    rawSegments: RawSegment[],
    processingMode: ProcessingMode = 'live_tunnel'
  ): CaptureSession {
    if (rawSegments.length === 0 || rawSegments.some((segment) => !segment.text.trim())) {
      throw new Error('A completed capture requires transcript text.');
    }
    const validatedSegments = validateSegments(rawSegments);

    const completedAt = this.clock().toISOString();
    const session: CaptureSession = {
      id: `session_${this.nextId}`,
      revision: validatedSegments.length + 1,
      source: { ...source },
      status: 'complete',
      createdAt: completedAt,
      stoppedAt: completedAt,
      processingMode,
      rawSegments: validatedSegments,
      derivedTranscripts: []
    };

    this.persistWith(session);
    this.nextId += 1;
    this.sessions.set(session.id, session);
    this.transcriptEvents.seed(this.streamSnapshot(session));
    return this.copySession(session);
  }

  getActiveSession(): CaptureSession | undefined {
    return this.activeSessionId ? this.getSession(this.activeSessionId) : undefined;
  }

  getSession(sessionId: string): CaptureSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.copySession(session) : undefined;
  }

  listSessions(): CaptureSession[] {
    return [...this.sessions.values()].reverse().map((session) => this.copySession(session));
  }

  changesSince(sessionId: string, afterRevision: number): TranscriptDelta {
    this.requireSession(sessionId);
    return this.transcriptEvents.changesSince(sessionId, afterRevision);
  }

  waitForChange(
    sessionId: string,
    afterRevision: number,
    options: TranscriptWaitOptions = {}
  ): Promise<TranscriptDelta | undefined> {
    this.requireSession(sessionId);
    return this.transcriptEvents.waitForChange(sessionId, afterRevision, options);
  }

  getLatestBrowserTranscript(): TranscriptResult | undefined {
    const session = this.listSessions().find(
      (candidate) => candidate.source.kind === 'chrome-tab'
        && candidate.status === 'complete'
        && candidate.rawSegments.length > 0
    );
    if (!session) {
      return undefined;
    }

    const segments = session.rawSegments.map((segment) => ({
      start: segment.startMs / 1_000,
      end: segment.endMs / 1_000,
      text: segment.text
    }));
    const sourceUrl = session.source.url && isHttpUrl(session.source.url) ? session.source.url : undefined;
    return createTranscriptResult({
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
      title: session.source.title ?? session.source.label,
      language: session.source.language ?? 'auto',
      duration_seconds: Math.max(...segments.map((segment) => segment.end), 0),
      processing_mode: session.processingMode ?? 'live_tunnel',
      transcript: segments.map((segment) => segment.text).join(' '),
      segments
    });
  }

  addDerivedTranscript(
    sessionId: string,
    transcript: DerivedTranscript
  ): CaptureSession {
    const session = this.requireSession(sessionId);
    const next = this.copySession(session);
    next.derivedTranscripts.push({ ...transcript });
    this.persistWith(next);
    this.sessions.set(next.id, next);
    return this.copySession(next);
  }

  private requireSession(sessionId: string): CaptureSession {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }

    return session;
  }

  private copySession(session: CaptureSession): CaptureSession {
    return {
      ...session,
      source: { ...session.source },
      rawSegments: session.rawSegments.map((segment) => ({ ...segment })),
      derivedTranscripts: session.derivedTranscripts.map((transcript) => ({
        ...transcript
      })),
      ...(session.failure ? { failure: { ...session.failure } } : {})
    };
  }

  private persist(): void {
    this.store?.save([...this.sessions.values()].map((session) => this.copySession(session)));
  }

  private persistWith(replacement: CaptureSession): void {
    const sessions = [...this.sessions.values()].map((session) => (
      session.id === replacement.id ? replacement : session
    ));
    if (!this.sessions.has(replacement.id)) {
      sessions.push(replacement);
    }
    this.store?.save(sessions.map((session) => this.copySession(session)));
  }

  private commitSession(next: CaptureSession, appendedSegments: RawSegment[] = []): CaptureSession {
    this.persistWith(next);
    this.sessions.set(next.id, next);
    this.transcriptEvents.publish(this.streamSnapshot(next), appendedSegments);
    return this.copySession(next);
  }

  private terminalTransition(
    session: CaptureSession,
    status: 'complete' | 'failed' | 'cancelled',
    failure?: TranscriptFailure
  ): CaptureSession {
    if (session.status !== 'capturing') {
      throw new Error(`Cannot transition ${session.id} from ${session.status} to ${status}.`);
    }
    const next: CaptureSession = {
      ...this.copySession(session),
      status,
      revision: session.revision + 1,
      stoppedAt: this.clock().toISOString(),
      ...(failure ? { failure: { ...failure } } : {})
    };
    const committed = this.commitSession(next);
    if (this.activeSessionId === session.id) {
      this.activeSessionId = undefined;
    }
    return committed;
  }

  private streamSnapshot(session: CaptureSession): TranscriptStreamSnapshot {
    return {
      sessionId: session.id,
      revision: session.revision,
      status: session.status,
      rawSegments: session.rawSegments,
      ...(session.failure ? { failure: { ...session.failure } } : {})
    };
  }

  private normalizeRecoveredSession(recovered: CaptureSession): CaptureSession {
    const copy = this.copySession({
      ...recovered,
      revision: Number.isSafeInteger(recovered.revision) && recovered.revision >= 0
        ? recovered.revision
        : inferredLegacyRevision(recovered)
    });
    if (copy.status !== 'failed' && copy.status !== 'cancelled') {
      delete copy.failure;
    }
    return copy;
  }
}

function numericId(id: string): number {
  const match = id.match(/^session_(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function inferredLegacyRevision(session: CaptureSession): number {
  return session.rawSegments.length + (session.status === 'capturing' ? 0 : 1);
}

function validateSegments(segments: RawSegment[]): RawSegment[] {
  const validated: RawSegment[] = [];
  for (const segment of segments) {
    validated.push(validateSegment(segment, validated.at(-1)));
  }
  return validated;
}

function validateSegment(segment: RawSegment, previous?: RawSegment): RawSegment {
  if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs)) {
    throw new Error('Transcript segment times must be finite.');
  }
  if (segment.startMs < 0 || segment.endMs <= segment.startMs) {
    throw new Error('Transcript segments require a nonnegative start and positive duration.');
  }
  const text = segment.text.trim();
  if (!text) {
    throw new Error('Transcript segment text must be nonempty.');
  }
  if (previous && segment.startMs < previous.endMs) {
    throw new Error('Transcript segments must be ordered and nonoverlapping.');
  }
  return { ...segment, text };
}

function validateFailure(failure: TranscriptFailure): TranscriptFailure {
  if (!failure.code || !failure.message.trim()) {
    throw new Error('Capture failure requires a stable code and nonempty message.');
  }
  return { ...failure, message: failure.message.trim() };
}
