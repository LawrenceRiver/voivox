import { describe, expect, it } from 'vitest';

import { VoivoxService } from '../src/voivox-service.js';

describe('VoivoxService', () => {
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
});
