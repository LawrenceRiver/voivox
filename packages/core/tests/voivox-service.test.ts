import { describe, expect, it } from 'vitest';

import { VoivoxService } from '../src/voivox-service.js';

describe('VoivoxService', () => {
  it('publishes one monotonic revision for every append and terminal transition', () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'chrome-tab', label: 'Revision source' });
    expect(session.revision).toBe(0);

    service.appendRawSegment(session.id, { startMs: 0, endMs: 1_000, text: 'first' });
    expect(service.changesSince(session.id, 0)).toMatchObject({
      afterRevision: 0,
      revision: 1,
      status: 'capturing',
      appendedSegments: [{ text: 'first' }]
    });

    service.appendRawSegment(session.id, { startMs: 1_000, endMs: 2_000, text: 'second' });
    expect(service.changesSince(session.id, 1)).toMatchObject({
      afterRevision: 1,
      revision: 2,
      status: 'capturing',
      appendedSegments: [{ text: 'second' }]
    });

    const completed = service.stopCapture(session.id);
    expect(completed.revision).toBe(3);
    expect(service.changesSince(session.id, 2)).toMatchObject({
      revision: 3,
      status: 'complete',
      appendedSegments: []
    });
  });

  it('publishes typed failed and cancelled terminal sessions exactly once', () => {
    const service = new VoivoxService();
    const failed = service.startCapture({ kind: 'chrome-tab', label: 'Failure source' });
    expect(service.failCapture(failed.id, {
      code: 'ASR_INFERENCE_FAILED',
      message: 'Local speech recognition failed.',
      retryable: true
    })).toMatchObject({
      revision: 1,
      status: 'failed',
      failure: { code: 'ASR_INFERENCE_FAILED', retryable: true }
    });
    expect(service.failCapture(failed.id, {
      code: 'ASR_INFERENCE_FAILED',
      message: 'Local speech recognition failed.',
      retryable: true
    }).revision).toBe(1);

    const cancelled = service.startCapture({ kind: 'chrome-tab', label: 'Cancelled source' });
    expect(service.cancelCapture(cancelled.id)).toMatchObject({
      revision: 1,
      status: 'cancelled',
      failure: { code: 'TRANSCRIPTION_CANCELLED', retryable: false }
    });
    expect(service.cancelCapture(cancelled.id).revision).toBe(1);
  });

  it('rejects empty, backwards, overlapping, and non-finite segments without publishing', () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'chrome-tab', label: 'Validated source' });

    expect(() => service.appendRawSegment(
      session.id,
      { startMs: 0, endMs: 1_000, text: '   ' }
    )).toThrow(/nonempty/i);
    expect(() => service.appendRawSegment(
      session.id,
      { startMs: 100, endMs: 100, text: 'backwards' }
    )).toThrow(/positive duration/i);
    expect(() => service.appendRawSegment(
      session.id,
      { startMs: Number.NaN, endMs: 100, text: 'non-finite' }
    )).toThrow(/finite/i);

    service.appendRawSegment(session.id, { startMs: 0, endMs: 1_000, text: 'valid' });
    expect(() => service.appendRawSegment(
      session.id,
      { startMs: 999, endMs: 2_000, text: 'overlap' }
    )).toThrow(/ordered and nonoverlapping/i);
    expect(service.getSession(session.id)).toMatchObject({ revision: 1 });
  });

  it('waits for exactly the next revision and supports cancellation', async () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'chrome-tab', label: 'Waiting source' });
    const waiting = service.waitForChange(session.id, 0, { waitMs: 1_000 });

    service.appendRawSegment(session.id, { startMs: 0, endMs: 500, text: 'new words' });

    await expect(waiting).resolves.toMatchObject({ revision: 1, status: 'capturing' });
    const controller = new AbortController();
    const aborted = service.waitForChange(session.id, 1, {
      signal: controller.signal,
      waitMs: 1_000
    });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('creates a capture session and accepts timestamped raw segments', () => {
    const service = new VoivoxService();

    const session = service.startCapture({
      kind: 'chrome-tab',
      label: '小红书 · 本期视频'
    });

    service.appendRawSegment(session.id, {
      startMs: 0,
      endMs: 860,
      text: '今天我们来聊一个很大胆的想法。'
    });

    const completed = service.stopCapture(session.id);

    expect(completed.status).toBe('complete');
    expect(completed.rawSegments).toEqual([
      {
        startMs: 0,
        endMs: 860,
        text: '今天我们来聊一个很大胆的想法。'
      }
    ]);
  });

  it('keeps raw text immutable when a derived transcript is added', () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'macos-process', label: 'Safari' });

    service.appendRawSegment(session.id, {
      startMs: 100,
      endMs: 640,
      text: '嗯 我们这个产品呢 可以静音收录'
    });
    service.stopCapture(session.id);

    const updated = service.addDerivedTranscript(session.id, {
      provider: 'openai-compatible',
      instruction: '只修正标点，不改写内容。',
      text: '嗯，我们这个产品呢，可以静音收录。'
    });

    expect(updated.rawSegments[0]?.text).toBe('嗯 我们这个产品呢 可以静音收录');
    expect(updated.derivedTranscripts).toEqual([
      {
        provider: 'openai-compatible',
        instruction: '只修正标点，不改写内容。',
        text: '嗯，我们这个产品呢，可以静音收录。'
      }
    ]);
  });

  it('refuses new raw segments after capture has stopped', () => {
    const service = new VoivoxService();
    const session = service.startCapture({ kind: 'microphone', label: 'Internal microphone' });
    service.stopCapture(session.id);

    expect(() =>
      service.appendRawSegment(session.id, { startMs: 0, endMs: 10, text: 'late audio' })
    ).toThrow('Cannot append transcript to completed session');
  });

  it('lists newest sessions first without exposing mutable internals', () => {
    const service = new VoivoxService(() => new Date('2026-07-16T01:00:00.000Z'));
    const first = service.startCapture({ kind: 'microphone', label: 'First' });
    service.stopCapture(first.id);
    const second = service.startCapture({ kind: 'chrome-tab', label: 'Second' });

    const sessions = service.listSessions();
    sessions[0]!.source.label = 'changed outside the service';

    expect(sessions.map((session) => session.id)).toEqual([second.id, first.id]);
    expect(service.getSession(second.id)?.source.label).toBe('Second');
    expect(service.getSession('does-not-exist')).toBeUndefined();
  });

  it('allows exactly one active capture across every Voice Vac surface', () => {
    const service = new VoivoxService();
    const active = service.startCapture({ kind: 'chrome-tab', label: 'Current tab' });

    expect(service.getActiveSession()).toMatchObject({ id: active.id, status: 'capturing' });
    expect(() => service.startCapture({ kind: 'macos-process', label: 'Safari' })).toThrow(
      'Voice Vac is already capturing another source.'
    );

    service.stopCapture(active.id);

    expect(service.getActiveSession()).toBeUndefined();
    expect(service.startCapture({ kind: 'macos-process', label: 'Safari' })).toMatchObject({
      status: 'capturing'
    });
  });

  it('imports a completed browser-local transcript without taking over an active capture', () => {
    const service = new VoivoxService(() => new Date('2026-07-16T10:00:00.000Z'));
    const active = service.startCapture({ kind: 'macos-process', label: 'Music' });

    const imported = service.importCompletedCapture(
      { kind: 'chrome-tab', label: 'My MV' },
      [{ startMs: 0, endMs: 12_500, text: '这是浏览器本地转写。' }]
    );

    expect(imported).toMatchObject({
      id: 'session_2',
      source: { kind: 'chrome-tab', label: 'My MV' },
      status: 'complete',
      stoppedAt: '2026-07-16T10:00:00.000Z',
      rawSegments: [{ startMs: 0, endMs: 12_500, text: '这是浏览器本地转写。' }]
    });
    expect(service.getActiveSession()?.id).toBe(active.id);
    expect(service.listSessions().map((session) => session.id)).toEqual(['session_2', 'session_1']);
  });

  it('preserves accelerated processing mode for the structured MCP result', () => {
    const service = new VoivoxService();
    service.importCompletedCapture(
      { kind: 'chrome-tab', label: 'Cached media', url: 'https://example.com/video.mp4' },
      [{ startMs: 0, endMs: 1_000, text: '极速批量转写。' }],
      'accelerated_batch'
    );

    expect(service.getLatestBrowserTranscript()).toMatchObject({
      processing_mode: 'accelerated_batch',
      source_url: 'https://example.com/video.mp4'
    });
  });

  it('rejects an empty browser-local transcript import', () => {
    const service = new VoivoxService();

    expect(() => service.importCompletedCapture(
      { kind: 'chrome-tab', label: 'Silent tab' },
      [{ startMs: 0, endMs: 500, text: '   ' }]
    )).toThrow('completed capture requires transcript text');
  });

  it('rejects overlapping segments in completed imports', () => {
    const service = new VoivoxService();

    expect(() => service.importCompletedCapture(
      { kind: 'chrome-tab', label: 'Bad import' },
      [
        { startMs: 0, endMs: 1_000, text: 'first' },
        { startMs: 900, endMs: 2_000, text: 'overlap' }
      ]
    )).toThrow(/ordered and nonoverlapping/i);
  });
});
