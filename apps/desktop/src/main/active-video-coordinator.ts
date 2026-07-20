import { randomUUID } from 'node:crypto';

import {
  ExtensionCommandBroker,
  VoiceVacError,
  type ActiveVideoTranscriptionOptions,
  type CrossWindowSession,
  type CrossWindowSessionStore,
  type TranscriptResult,
  type VoiceVacErrorCode,
  type VoivoxService
} from '@voivox/core';

import type {
  ExtensionCaptureBinding,
  ExtensionCaptureController
} from './extension-capture-controller.js';

const DROP_TOKEN = /^VOICE_VAC_DROP_V1\|([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\|[A-Za-z0-9_-]{43}$/iu;
const DEFAULT_COMMAND_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_TRANSCRIPTION_DEADLINE_MS = 30 * 60_000;
const MAXIMUM_TRANSCRIPT_WAIT_MS = 25_000;

export type ActiveVideoCoordinatorOptions = Readonly<{
  commandAckTimeoutMs?: number;
  extensionCaptureController: Pick<
    ExtensionCaptureController,
    'waitForJob'
  >;
  extensionCommands: ExtensionCommandBroker;
  now?: () => number;
  randomUUID?: () => string;
  service: VoivoxService;
  transcriptionDeadlineMs?: number;
  tunnelSessions: CrossWindowSessionStore;
}>;

/**
 * Starts one exact browser capture and waits on that capture's revisions. It
 * never substitutes an older completed transcript for the requested video.
 */
export class ActiveVideoCoordinator {
  private readonly commandAckTimeoutMs: number;
  private readonly extensionCaptureController: ActiveVideoCoordinatorOptions['extensionCaptureController'];
  private readonly extensionCommands: ExtensionCommandBroker;
  private inFlight?: Promise<TranscriptResult>;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly service: VoivoxService;
  private readonly transcriptionDeadlineMs: number;
  private readonly tunnelSessions: CrossWindowSessionStore;

  constructor(options: ActiveVideoCoordinatorOptions) {
    this.commandAckTimeoutMs = positiveBoundedTimeout(
      options.commandAckTimeoutMs ?? DEFAULT_COMMAND_ACK_TIMEOUT_MS,
      30_000,
      'command acknowledgement'
    );
    this.transcriptionDeadlineMs = positiveBoundedTimeout(
      options.transcriptionDeadlineMs ?? DEFAULT_TRANSCRIPTION_DEADLINE_MS,
      60 * 60_000,
      'transcription deadline'
    );
    this.extensionCaptureController = options.extensionCaptureController;
    this.extensionCommands = options.extensionCommands;
    this.now = options.now ?? Date.now;
    this.randomUUID = options.randomUUID ?? randomUUID;
    this.service = options.service;
    this.tunnelSessions = options.tunnelSessions;
  }

  transcribe(request: ActiveVideoTranscriptionOptions): Promise<TranscriptResult> {
    if (this.inFlight) return this.inFlight;
    const work = this.run(request);
    this.inFlight = work;
    void work.finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    }).catch(() => undefined);
    return work;
  }

  private async run(request: ActiveVideoTranscriptionOptions): Promise<TranscriptResult> {
    if (request.mode === 'accelerated') {
      throw new VoiceVacError('ACCELERATED_SOURCE_UNAVAILABLE');
    }
    const target = selectReadyTarget(this.tunnelSessions.list());
    if (!target) throw new VoiceVacError('NEEDS_USER_ARMING');
    const targetSessionId = dropSessionId(target.dropToken);
    if (!targetSessionId) throw new VoiceVacError('TAB_NOT_ARMED');

    const commandId = this.randomUUID().toLowerCase();
    this.extensionCommands.publish({
      commandId,
      issuedAt: this.now(),
      protocolVersion: 2,
      sessionId: targetSessionId,
      type: 'capture-start'
    });
    const binding = await this.extensionCaptureController.waitForJob(
      commandId,
      this.commandAckTimeoutMs
    );
    if (!binding) throw new VoiceVacError('COMMAND_ACK_TIMEOUT');
    return this.waitForExactTranscript(binding, targetSessionId);
  }

  private async waitForExactTranscript(
    binding: ExtensionCaptureBinding,
    targetSessionId: string
  ): Promise<TranscriptResult> {
    const deadline = this.now() + this.transcriptionDeadlineMs;
    let revision = this.service.getSession(binding.captureSessionId)?.revision ?? 0;

    while (true) {
      const session = this.service.getSession(binding.captureSessionId);
      if (!session) throw new VoiceVacError('STREAM_ENDED');
      if (session.status === 'complete') {
        const result = this.service.getBrowserTranscript(binding.captureSessionId);
        if (!result) throw new VoiceVacError('ASR_INFERENCE_FAILED');
        return result;
      }
      if (session.status === 'failed') {
        throw new VoiceVacError(asVoiceVacErrorCode(session.failure?.code));
      }
      if (session.status === 'cancelled') throw new VoiceVacError('TRANSCRIPTION_CANCELLED');
      if (session.status === 'interrupted') throw new VoiceVacError('STREAM_ENDED');

      const remaining = deadline - this.now();
      if (remaining <= 0) {
        this.extensionCommands.publish({
          commandId: this.randomUUID().toLowerCase(),
          issuedAt: this.now(),
          protocolVersion: 2,
          sessionId: targetSessionId,
          type: 'capture-stop'
        });
        throw new VoiceVacError('TRANSCRIPTION_DEADLINE_EXCEEDED');
      }
      const delta = await this.service.waitForChange(binding.captureSessionId, revision, {
        waitMs: Math.max(1, Math.min(MAXIMUM_TRANSCRIPT_WAIT_MS, Math.ceil(remaining)))
      });
      if (delta) revision = delta.revision;
    }
  }
}

function selectReadyTarget(sessions: readonly CrossWindowSession[]): CrossWindowSession | undefined {
  return sessions
    .filter((session) => session.state === 'ready')
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

function dropSessionId(token: string): string | undefined {
  return DROP_TOKEN.exec(token)?.[1]?.toLowerCase();
}

function positiveBoundedTimeout(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`Voice VAC ${name} timeout is out of range.`);
  }
  return value;
}

function asVoiceVacErrorCode(value: string | undefined): VoiceVacErrorCode {
  const codes: readonly VoiceVacErrorCode[] = [
    'NEEDS_USER_ARMING', 'TAB_NOT_ARMED', 'TARGET_NAVIGATED', 'TAB_CLOSED',
    'CAPTURE_DENIED', 'STREAM_ID_EXPIRED', 'STREAM_ENDED', 'NATIVE_HOST_UNAVAILABLE',
    'EXTENSION_UNAVAILABLE', 'COMMAND_ACK_TIMEOUT', 'ASR_RUNTIME_MISSING',
    'ASR_MODEL_MISSING', 'ASR_MODEL_LOAD_FAILED', 'ASR_STARTUP_TIMEOUT',
    'ASR_INFERENCE_TIMEOUT', 'ASR_INFERENCE_FAILED', 'AUDIO_SEQUENCE_MISMATCH',
    'AUDIO_RELAY_BACKPRESSURE', 'NO_AUDIO_AFTER_TIMEOUT', 'TRANSCRIPTION_CANCELLED',
    'TRANSCRIPTION_DEADLINE_EXCEEDED', 'ACCELERATED_SOURCE_UNAVAILABLE'
  ];
  return codes.includes(value as VoiceVacErrorCode)
    ? value as VoiceVacErrorCode
    : 'ASR_INFERENCE_FAILED';
}
