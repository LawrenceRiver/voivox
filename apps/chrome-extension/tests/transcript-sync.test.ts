import { describe, expect, it } from 'vitest';

import { syncBrowserTranscriptToDesktop } from '../src/transcript-sync.js';

describe('browser transcript desktop sync', () => {
  it('sends text-only output through the restricted native bridge', async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const request: typeof fetch = async (input, init) => {
      captured = { input, init };
      return new Response('{}', { status: 201 });
    };

    await expect(syncBrowserTranscriptToDesktop({
      bridge: { baseUrl: 'http://127.0.0.1:43817', token: 'restricted-token' },
      durationSeconds: 12.501,
      tabTitle: 'My MV',
      tabUrl: 'https://example.com/watch/123',
      transcript: '  本地转写文字。  '
    }, request)).resolves.toBe(true);

    expect(captured?.input).toBe('http://127.0.0.1:43817/v1/extension/transcripts');
    const options = captured?.init as RequestInit;
    expect(options).toMatchObject({
      method: 'POST',
      headers: {
        authorization: 'Bearer restricted-token',
        'content-type': 'application/json'
      }
    });
    expect(JSON.parse(options.body as string)).toEqual({
      durationMs: 12_501,
      source: {
        kind: 'chrome-tab',
        label: 'My MV',
        title: 'My MV',
        url: 'https://example.com/watch/123'
      },
      transcript: '本地转写文字。'
    });
    expect(options.body).not.toContain('audio');
  });

  it('is optional and never turns a successful local transcription into an error', async () => {
    let requestCount = 0;
    const unavailable: typeof fetch = async () => {
      requestCount += 1;
      throw new Error('App closed');
    };

    await expect(syncBrowserTranscriptToDesktop({
      durationSeconds: 3,
      tabTitle: 'Standalone',
      transcript: '扩展独立运行'
    }, unavailable)).resolves.toBe(false);
    expect(requestCount).toBe(0);

    await expect(syncBrowserTranscriptToDesktop({
      bridge: { baseUrl: 'http://127.0.0.1:43817', token: 'restricted-token' },
      durationSeconds: 3,
      tabTitle: 'Standalone',
      transcript: '扩展独立运行'
    }, unavailable)).resolves.toBe(false);
    expect(requestCount).toBe(1);
  });
});
