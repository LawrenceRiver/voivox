import { describe, expect, it } from 'vitest';

import {
  CrossWindowSessionStore,
  ExtensionCommandBroker,
  VoivoxService
} from '@voivox/core';
import { ActiveVideoCoordinator } from '../src/main/active-video-coordinator.js';
import {
  ExtensionCaptureController,
  type ExtensionPcmPipeline
} from '../src/main/extension-capture-controller.js';

const TARGET_UUID = '2b0fe529-4021-4674-b55e-1cf081f947dd';
const DROP_TOKEN = `VOICE_VAC_DROP_V1|${TARGET_UUID}|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const COMMAND_UUID = '4f0fe529-4021-4674-b55e-1cf081f947aa';
const STOP_UUID = '5f0fe529-4021-4674-b55e-1cf081f947bb';

describe('ActiveVideoCoordinator', () => {
  it('commands and returns only the exact newly bound browser capture', async () => {
    const harness = readyHarness();
    harness.service.importCompletedCapture(
      { kind: 'chrome-tab', label: 'Old unrelated tab' },
      [{ startMs: 0, endMs: 1_000, text: 'old transcript' }]
    );
    const coordinator = makeCoordinator(harness);

    const work = coordinator.transcribe(request());
    const command = harness.commands.readAfter(0).commands[0]!;
    expect(command).toEqual({
      commandId: COMMAND_UUID,
      issuedAt: 1_000,
      protocolVersion: 2,
      sessionId: TARGET_UUID,
      type: 'capture-start'
    });

    const capture = harness.controller.startCapture({
      jobId: command.commandId,
      mode: 'quality',
      source: {
        kind: 'chrome-tab',
        label: 'Current MV',
        language: 'zh',
        title: 'Current MV',
        url: 'https://example.test/current'
      },
      tunnelSessionId: harness.tunnelId
    });
    harness.controller.ingestAudio(capture.id, 0, new Uint8Array([0, 0]));
    harness.service.appendRawSegment(capture.id, {
      startMs: 0,
      endMs: 2_500,
      text: '这是当前视频。'
    });
    await harness.controller.stopCapture(capture.id);

    await expect(work).resolves.toMatchObject({
      status: 'completed',
      source_url: 'https://example.test/current',
      title: 'Current MV',
      transcript: '这是当前视频。',
      processing_mode: 'live_tunnel'
    });
  });

  it('requires a ready armed target and does not fall back to history', async () => {
    const harness = readyHarness();
    harness.tunnels.update(harness.tunnelId, { state: 'idle' });
    harness.service.importCompletedCapture(
      { kind: 'chrome-tab', label: 'Old tab' },
      [{ startMs: 0, endMs: 1_000, text: 'old transcript' }]
    );

    await expect(makeCoordinator(harness).transcribe(request())).rejects.toMatchObject({
      code: 'NEEDS_USER_ARMING'
    });
    expect(harness.commands.readAfter(0).commands).toEqual([]);
  });

  it('returns a stable acknowledgement timeout when the extension never binds the job', async () => {
    const harness = readyHarness();
    const coordinator = makeCoordinator(harness, { commandAckTimeoutMs: 5 });

    await expect(coordinator.transcribe(request())).rejects.toMatchObject({
      code: 'COMMAND_ACK_TIMEOUT'
    });
  });

  it('fails explicit accelerated mode honestly before publishing a command', async () => {
    const harness = readyHarness();

    await expect(makeCoordinator(harness).transcribe({
      ...request(),
      mode: 'accelerated'
    })).rejects.toMatchObject({ code: 'ACCELERATED_SOURCE_UNAVAILABLE' });
    expect(harness.commands.readAfter(0).commands).toEqual([]);
  });

  it('stops the exact target and reports the overall transcription deadline', async () => {
    const harness = readyHarness();
    const ids = [COMMAND_UUID, STOP_UUID];
    let now = 0;
    const coordinator = new ActiveVideoCoordinator({
      commandAckTimeoutMs: 50,
      extensionCaptureController: harness.controller,
      extensionCommands: harness.commands,
      now: () => {
        const value = now;
        now += 10;
        return value;
      },
      randomUUID: () => ids.shift()!,
      service: harness.service,
      transcriptionDeadlineMs: 5,
      tunnelSessions: harness.tunnels
    });

    const work = coordinator.transcribe(request());
    const start = harness.commands.readAfter(0).commands[0]!;
    const capture = harness.controller.startCapture({
      jobId: start.commandId,
      mode: 'fast',
      source: {
        kind: 'chrome-tab',
        label: 'Current MV',
        url: 'https://example.test/current'
      },
      tunnelSessionId: harness.tunnelId
    });
    harness.service.appendRawSegment(capture.id, {
      startMs: 0,
      endMs: 500,
      text: 'partial'
    });

    await expect(work).rejects.toMatchObject({ code: 'TRANSCRIPTION_DEADLINE_EXCEEDED' });
    expect(harness.commands.readAfter(0).commands.at(-1)).toMatchObject({
      commandId: STOP_UUID,
      sessionId: TARGET_UUID,
      type: 'capture-stop'
    });
    harness.service.cancelCapture(capture.id);
  });
});

function request() {
  return {
    language: 'auto',
    mode: 'auto' as const,
    output_format: 'text' as const,
    timestamps: false
  };
}

function makeCoordinator(
  harness: ReturnType<typeof readyHarness>,
  overrides: { commandAckTimeoutMs?: number } = {}
): ActiveVideoCoordinator {
  return new ActiveVideoCoordinator({
    commandAckTimeoutMs: overrides.commandAckTimeoutMs ?? 100,
    extensionCaptureController: harness.controller,
    extensionCommands: harness.commands,
    now: () => 1_000,
    randomUUID: () => COMMAND_UUID,
    service: harness.service,
    transcriptionDeadlineMs: 500,
    tunnelSessions: harness.tunnels
  });
}

function readyHarness() {
  const service = new VoivoxService();
  const tunnels = new CrossWindowSessionStore();
  const tunnel = tunnels.create(9, {
    documentId: 'document-9',
    dropToken: DROP_TOKEN,
    frameId: 0,
    state: 'ready',
    title: 'Current MV',
    url: 'https://example.test/current'
  });
  const pipeline: ExtensionPcmPipeline = {
    configureSession: () => undefined,
    finish: async () => undefined,
    ingest: () => undefined
  };
  const controller = new ExtensionCaptureController({ pipeline, service, tunnelSessions: tunnels });
  return {
    commands: new ExtensionCommandBroker(),
    controller,
    service,
    tunnelId: tunnel.id,
    tunnels
  };
}
