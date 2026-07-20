import {
  VoiceVacError,
  isVoiceVacError,
  type CaptureSession,
  type CrossWindowSession,
  type CrossWindowSessionStore,
  type ExtensionCaptureStartRequest as CoreExtensionCaptureStartRequest,
  type TranscriptDelta,
  type VoivoxService
} from '@voivox/core';

import type { BufferedAudioChunk } from './asr-pipeline.js';

const MAXIMUM_PCM_CHUNK_BYTES = 128 * 1024;
const MAXIMUM_TRANSCRIPT_WAIT_MS = 25_000;
const MAXIMUM_JOB_WAIT_MS = 30_000;
const MAXIMUM_RETAINED_TERMINAL_BINDINGS = 32;

export type ExtensionCaptureStartRequest = CoreExtensionCaptureStartRequest;

export type ExtensionCaptureBinding = Readonly<{
  canonicalUrl: string;
  captureSessionId: string;
  documentId: string;
  frameId: number;
  jobId?: string;
  nextSequence: number;
  receivedBytes: number;
  stopping: boolean;
  tabId: number;
  tunnelSessionId: string;
}>;

export type ExtensionPcmPipeline = {
  configureSession(sessionId: string, mode: 'fast' | 'quality'): void;
  finish(sessionId: string): Promise<void>;
  ingest(chunk: BufferedAudioChunk): void;
};

type MutableBinding = {
  canonicalUrl: string;
  captureSessionId: string;
  documentId: string;
  frameId: number;
  jobId?: string;
  nextSequence: number;
  receivedBytes: number;
  stopping: boolean;
  stopPromise?: Promise<CaptureSession>;
  tabId: number;
  terminal: boolean;
  terminalError?: VoiceVacError;
  tunnelSessionId: string;
};

type JobWaiter = {
  timer: ReturnType<typeof setTimeout>;
  resolve: (binding: ExtensionCaptureBinding | undefined) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

export class ExtensionCaptureController {
  private readonly bindings = new Map<string, MutableBinding>();
  private readonly jobWaiters = new Map<string, Set<JobWaiter>>();
  private readonly pipeline: ExtensionPcmPipeline;
  private readonly service: VoivoxService;
  private readonly terminalBindingIds: string[] = [];
  private readonly tunnelSessions: CrossWindowSessionStore;

  constructor(options: {
    pipeline: ExtensionPcmPipeline;
    service: VoivoxService;
    tunnelSessions: CrossWindowSessionStore;
  }) {
    this.pipeline = options.pipeline;
    this.service = options.service;
    this.tunnelSessions = options.tunnelSessions;
  }

  startCapture(request: ExtensionCaptureStartRequest): CaptureSession {
    assertStartRequest(request);
    this.synchronizeAllBindings();
    const tunnel = this.tunnelSessions.get(request.tunnelSessionId);
    if (!tunnel || tunnel.state !== 'ready') {
      throw new VoiceVacError('TAB_NOT_ARMED');
    }
    if (!isCanonicalHttpUrl(tunnel.url)) {
      throw new VoiceVacError('TAB_NOT_ARMED');
    }
    if (!isCanonicalHttpUrl(request.source.url) || request.source.url !== tunnel.url) {
      throw new VoiceVacError('TARGET_NAVIGATED');
    }

    const session = this.service.startCapture({
      ...request.source,
      ...(tunnel.title && request.source.title === undefined ? { title: tunnel.title } : {}),
      url: tunnel.url
    });
    try {
      this.pipeline.configureSession(session.id, request.mode);
    } catch (error) {
      const failure = normalizeAsrFailure(error);
      this.service.failCapture(session.id, {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable
      });
      throw failure;
    }
    this.bindings.set(session.id, {
      canonicalUrl: tunnel.url,
      captureSessionId: session.id,
      documentId: tunnel.documentId,
      frameId: tunnel.frameId,
      ...(request.jobId ? { jobId: request.jobId } : {}),
      nextSequence: 0,
      receivedBytes: 0,
      stopping: false,
      tabId: tunnel.tabId,
      terminal: false,
      tunnelSessionId: request.tunnelSessionId
    });
    if (request.jobId) this.resolveJobWaiters(request.jobId);
    return session;
  }

  hasCapture(sessionId: string): boolean {
    const binding = this.bindings.get(sessionId);
    if (!binding) return false;
    this.synchronizeServiceTerminal(binding);
    return this.bindings.has(sessionId);
  }

  getBinding(sessionId: string): ExtensionCaptureBinding | undefined {
    const binding = this.bindings.get(sessionId);
    if (!binding) return undefined;
    this.synchronizeServiceTerminal(binding);
    return this.bindings.has(sessionId) ? copyBinding(binding) : undefined;
  }

  getBindingForJob(jobId: string): ExtensionCaptureBinding | undefined {
    assertJobId(jobId);
    const binding = [...this.bindings.values()]
      .reverse()
      .find((candidate) => candidate.jobId === jobId);
    if (!binding) return undefined;
    this.synchronizeServiceTerminal(binding);
    return this.bindings.has(binding.captureSessionId) ? copyBinding(binding) : undefined;
  }

  waitForJob(
    jobId: string,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<ExtensionCaptureBinding | undefined> {
    assertJobId(jobId);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAXIMUM_JOB_WAIT_MS) {
      throw new Error('Extension capture job wait must be between 0 and 30000 ms.');
    }
    const immediate = this.getBindingForJob(jobId);
    if (immediate || waitMs === 0 || signal?.aborted) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      const waiter: JobWaiter = {
        resolve,
        timer: setTimeout(() => this.settleJobWaiter(jobId, waiter), waitMs),
        ...(signal ? { signal } : {})
      };
      if (signal) {
        waiter.abort = () => this.settleJobWaiter(jobId, waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      const waiters = this.jobWaiters.get(jobId) ?? new Set<JobWaiter>();
      waiters.add(waiter);
      this.jobWaiters.set(jobId, waiters);
      if (signal?.aborted) this.settleJobWaiter(jobId, waiter);
      else {
        const afterRegistration = this.getBindingForJob(jobId);
        if (afterRegistration) this.resolveJobWaiters(jobId);
      }
    });
  }

  getTranscriptRevision(sessionId: string): number {
    const binding = this.requireBinding(sessionId);
    this.synchronizeServiceTerminal(binding);
    this.revalidateActiveTunnel(binding);
    const session = this.service.getSession(sessionId);
    if (!session) throw new VoiceVacError('STREAM_ENDED');
    return session.revision;
  }

  ingestAudio(sessionId: string, sequence: number, pcm: Uint8Array): void {
    const binding = this.requireOpenBinding(sessionId);
    this.revalidateActiveTunnel(binding);
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence !== binding.nextSequence) {
      throw new VoiceVacError('AUDIO_SEQUENCE_MISMATCH');
    }
    assertPcmChunk(pcm);
    const isolatedPcm = new Uint8Array(pcm);
    try {
      this.pipeline.ingest({
        channels: 1,
        pcm: isolatedPcm,
        sampleRate: 16_000,
        sessionId
      });
    } catch (error) {
      const failure = normalizeAsrFailure(error);
      this.failAndRetain(binding, failure);
      this.drainInvalidatedPipeline(binding.captureSessionId);
      throw failure;
    }
    binding.nextSequence += 1;
    binding.receivedBytes += isolatedPcm.byteLength;
  }

  async waitForTranscript(
    sessionId: string,
    afterRevision: number,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<TranscriptDelta | undefined> {
    const binding = this.requireBinding(sessionId);
    this.synchronizeServiceTerminal(binding);
    this.revalidateActiveTunnel(binding);
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new Error('Transcript after_revision must be a nonnegative integer.');
    }
    if (!Number.isSafeInteger(waitMs) || waitMs <= 0 || waitMs > MAXIMUM_TRANSCRIPT_WAIT_MS) {
      throw new Error('Transcript wait_ms must be between 1 and 25000.');
    }
    const delta = await this.service.waitForChange(sessionId, afterRevision, {
      waitMs,
      ...(signal ? { signal } : {})
    });
    this.synchronizeServiceTerminal(binding);
    this.revalidateActiveTunnel(binding);
    return delta;
  }

  stopCapture(sessionId: string): Promise<CaptureSession> {
    const binding = this.requireBinding(sessionId);
    if (binding.stopPromise) return binding.stopPromise;
    this.synchronizeServiceTerminal(binding);
    if (binding.terminalError) {
      binding.stopPromise = Promise.reject(binding.terminalError);
      return binding.stopPromise;
    }
    if (binding.terminal) {
      const terminalSession = this.service.getSession(sessionId);
      binding.stopPromise = terminalSession?.status === 'complete'
        ? Promise.resolve(terminalSession)
        : Promise.reject(new VoiceVacError('STREAM_ENDED'));
      return binding.stopPromise;
    }

    try {
      this.revalidateActiveTunnel(binding);
    } catch (error) {
      binding.stopPromise = Promise.reject(error);
      return binding.stopPromise;
    }

    binding.stopping = true;
    binding.stopPromise = this.finishCapture(binding);
    return binding.stopPromise;
  }

  private async finishCapture(binding: MutableBinding): Promise<CaptureSession> {
    try {
      await this.pipeline.finish(binding.captureSessionId);
    } catch (error) {
      this.synchronizeServiceTerminal(binding);
      const failure = binding.terminalError ?? normalizeAsrFailure(error);
      this.failAndRetain(binding, failure);
      throw failure;
    }
    this.synchronizeServiceTerminal(binding);
    if (binding.terminalError) throw binding.terminalError;
    this.revalidateActiveTunnel(binding);
    if (binding.receivedBytes === 0) {
      const failure = new VoiceVacError('NO_AUDIO_AFTER_TIMEOUT');
      this.failAndRetain(binding, failure);
      throw failure;
    }

    const session = this.service.getSession(binding.captureSessionId);
    if (!session) {
      const failure = new VoiceVacError('STREAM_ENDED');
      this.failAndRetain(binding, failure);
      throw failure;
    }
    if (session.status === 'capturing') {
      const completed = this.service.stopCapture(binding.captureSessionId);
      this.retainTerminal(binding);
      return completed;
    }
    if (session.status === 'complete') {
      this.retainTerminal(binding);
      return session;
    }
    if (session.failure) {
      const failure = new VoiceVacError(session.failure.code);
      binding.terminalError = failure;
      this.retainTerminal(binding);
      throw failure;
    }
    const failure = new VoiceVacError('STREAM_ENDED');
    binding.terminalError = failure;
    this.retainTerminal(binding);
    throw failure;
  }

  private validateBoundTunnel(binding: MutableBinding): VoiceVacError | undefined {
    const tunnel = this.tunnelSessions.get(binding.tunnelSessionId);
    if (!tunnel) return new VoiceVacError('TAB_CLOSED');
    if (!hasSameChromeIdentity(binding, tunnel)) {
      return new VoiceVacError('TARGET_NAVIGATED');
    }
    if (!isCanonicalHttpUrl(tunnel.url) || tunnel.url !== binding.canonicalUrl) {
      return new VoiceVacError('TARGET_NAVIGATED');
    }
    if (tunnel.state === 'error') {
      if (tunnel.errorCode === 'TAB_CLOSED') return new VoiceVacError('TAB_CLOSED');
      if (tunnel.errorCode === 'TARGET_NAVIGATED') return new VoiceVacError('TARGET_NAVIGATED');
      return new VoiceVacError('STREAM_ENDED');
    }
    if (tunnel.state !== 'ready' && tunnel.state !== 'transcribing' && tunnel.state !== 'paused') {
      return new VoiceVacError(tunnel.state === 'completed' ? 'STREAM_ENDED' : 'TAB_NOT_ARMED');
    }
    return undefined;
  }

  private failAndRetain(binding: MutableBinding, failure: VoiceVacError): void {
    binding.stopping = true;
    binding.terminalError = failure;
    const session = this.service.getSession(binding.captureSessionId);
    if (session?.status === 'capturing') {
      this.service.failCapture(binding.captureSessionId, {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable
      });
    }
    this.retainTerminal(binding);
  }

  private revalidateActiveTunnel(binding: MutableBinding): void {
    if (binding.terminal) return;
    const tunnelError = this.validateBoundTunnel(binding);
    if (!tunnelError) return;
    this.failAndRetain(binding, tunnelError);
    this.drainInvalidatedPipeline(binding.captureSessionId);
    throw tunnelError;
  }

  private synchronizeAllBindings(): void {
    for (const binding of [...this.bindings.values()]) {
      this.synchronizeServiceTerminal(binding);
    }
  }

  private synchronizeServiceTerminal(binding: MutableBinding): void {
    if (binding.terminal) return;
    const session = this.service.getSession(binding.captureSessionId);
    if (session?.status === 'capturing') return;
    if (session?.status === 'complete') {
      this.retainTerminal(binding);
      return;
    }

    const failure = session?.failure
      ? new VoiceVacError(session.failure.code)
      : new VoiceVacError(session?.status === 'cancelled' ? 'TRANSCRIPTION_CANCELLED' : 'STREAM_ENDED');
    binding.terminalError = failure;
    this.retainTerminal(binding);
    this.drainInvalidatedPipeline(binding.captureSessionId);
  }

  private retainTerminal(binding: MutableBinding): void {
    if (binding.terminal) return;
    binding.terminal = true;
    binding.stopping = true;
    this.terminalBindingIds.push(binding.captureSessionId);
    while (this.terminalBindingIds.length > MAXIMUM_RETAINED_TERMINAL_BINDINGS) {
      const expiredSessionId = this.terminalBindingIds.shift();
      if (expiredSessionId) this.bindings.delete(expiredSessionId);
    }
  }

  private drainInvalidatedPipeline(sessionId: string): void {
    void this.pipeline.finish(sessionId).catch(() => undefined);
  }

  private resolveJobWaiters(jobId: string): void {
    const waiters = this.jobWaiters.get(jobId);
    if (!waiters) return;
    for (const waiter of [...waiters]) this.settleJobWaiter(jobId, waiter);
  }

  private settleJobWaiter(jobId: string, waiter: JobWaiter): void {
    const waiters = this.jobWaiters.get(jobId);
    if (!waiters?.delete(waiter)) return;
    if (waiters.size === 0) this.jobWaiters.delete(jobId);
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener('abort', waiter.abort);
    }
    waiter.resolve(this.getBindingForJob(jobId));
  }

  private requireBinding(sessionId: string): MutableBinding {
    const binding = this.bindings.get(sessionId);
    if (!binding) throw new VoiceVacError('STREAM_ENDED');
    return binding;
  }

  private requireOpenBinding(sessionId: string): MutableBinding {
    const binding = this.requireBinding(sessionId);
    this.synchronizeServiceTerminal(binding);
    if (binding.terminalError) throw binding.terminalError;
    if (binding.stopping) throw new VoiceVacError('STREAM_ENDED');
    return binding;
  }
}

function assertStartRequest(request: ExtensionCaptureStartRequest): void {
  if (
    !request
    || typeof request !== 'object'
    || request.source?.kind !== 'chrome-tab'
    || !request.source.label?.trim()
  ) {
    throw new Error('Extension capture source must be a Chrome tab.');
  }
  if (!request.tunnelSessionId?.trim()) {
    throw new Error('Extension capture requires a tunnel session id.');
  }
  if (request.mode !== 'fast' && request.mode !== 'quality') {
    throw new Error('Extension capture mode must be fast or quality.');
  }
  if (request.jobId !== undefined && !request.jobId.trim()) {
    throw new Error('Extension capture job id must be nonempty when supplied.');
  }
}

function assertJobId(jobId: string): void {
  if (!jobId || jobId.trim() !== jobId || jobId.length > 200) {
    throw new Error('Extension capture job id must be a nonempty bounded string.');
  }
}

function assertPcmChunk(pcm: Uint8Array): void {
  if (!(pcm instanceof Uint8Array)) {
    throw new Error('Extension audio must be PCM16 bytes.');
  }
  if (
    pcm.byteLength === 0
    || pcm.byteLength > MAXIMUM_PCM_CHUNK_BYTES
    || pcm.byteLength % 2 !== 0
  ) {
    throw new Error('Extension audio must contain 1 to 128 KiB of complete PCM16 samples.');
  }
}

function copyBinding(binding: MutableBinding): ExtensionCaptureBinding {
  return {
    canonicalUrl: binding.canonicalUrl,
    captureSessionId: binding.captureSessionId,
    documentId: binding.documentId,
    frameId: binding.frameId,
    ...(binding.jobId ? { jobId: binding.jobId } : {}),
    nextSequence: binding.nextSequence,
    receivedBytes: binding.receivedBytes,
    stopping: binding.stopping,
    tabId: binding.tabId,
    tunnelSessionId: binding.tunnelSessionId
  };
}

function normalizeAsrFailure(error: unknown): VoiceVacError {
  return isVoiceVacError(error)
    ? error
    : new VoiceVacError('ASR_INFERENCE_FAILED', undefined, undefined, undefined, error);
}

function isCanonicalHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function hasSameChromeIdentity(
  binding: Pick<MutableBinding, 'documentId' | 'frameId' | 'tabId'>,
  tunnel: CrossWindowSession
): boolean {
  return binding.tabId === tunnel.tabId
    && binding.frameId === tunnel.frameId
    && binding.documentId === tunnel.documentId;
}
