import { createTranscriptResult, type ProcessingMode, type TranscriptResult } from './pvtt-contract.js';
import type { SessionStore } from './session-store.js';

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

export type CaptureStatus = 'capturing' | 'complete' | 'interrupted';

export type CaptureSession = {
  id: string;
  source: CaptureSource;
  status: CaptureStatus;
  createdAt: string;
  stoppedAt?: string;
  rawSegments: RawSegment[];
  derivedTranscripts: DerivedTranscript[];
  processingMode?: ProcessingMode;
};

export class VoivoxService {
  private readonly sessions = new Map<string, CaptureSession>();
  private activeSessionId: string | undefined;
  private nextId = 1;

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly store?: SessionStore
  ) {
    const recoveredSessions = store?.load() ?? [];
    let didRecoverInterruptedSession = false;

    for (const recovered of recoveredSessions) {
      const session = this.copySession(recovered);
      if (session.status === 'capturing') {
        session.status = 'interrupted';
        session.stoppedAt = this.clock().toISOString();
        didRecoverInterruptedSession = true;
      }
      this.sessions.set(session.id, session);
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
      id: `session_${this.nextId++}`,
      source,
      status: 'capturing',
      createdAt: this.clock().toISOString(),
      rawSegments: [],
      derivedTranscripts: []
    };

    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    this.persist();
    return this.copySession(session);
  }

  appendRawSegment(sessionId: string, segment: RawSegment): void {
    const session = this.requireSession(sessionId);

    if (session.status !== 'capturing') {
      throw new Error(`Cannot append transcript to completed session ${sessionId}`);
    }

    session.rawSegments.push({ ...segment });
    this.persist();
  }

  stopCapture(sessionId: string): CaptureSession {
    const session = this.requireSession(sessionId);
    session.status = 'complete';
    session.stoppedAt = this.clock().toISOString();
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = undefined;
    }
    this.persist();
    return this.copySession(session);
  }

  importCompletedCapture(
    source: CaptureSource,
    rawSegments: RawSegment[],
    processingMode: ProcessingMode = 'live_tunnel'
  ): CaptureSession {
    if (
      rawSegments.length === 0
      || rawSegments.some((segment) => !segment.text.trim())
    ) {
      throw new Error('A completed capture requires transcript text.');
    }

    const completedAt = this.clock().toISOString();
    const session: CaptureSession = {
      id: `session_${this.nextId++}`,
      source: { ...source },
      status: 'complete',
      createdAt: completedAt,
      stoppedAt: completedAt,
      processingMode,
      rawSegments: rawSegments.map((segment) => ({
        ...segment,
        text: segment.text.trim()
      })),
      derivedTranscripts: []
    };

    this.sessions.set(session.id, session);
    this.persist();
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
    session.derivedTranscripts.push({ ...transcript });
    this.persist();
    return this.copySession(session);
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
      }))
    };
  }

  private persist(): void {
    this.store?.save([...this.sessions.values()].map((session) => this.copySession(session)));
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
