import { afterEach, describe, expect, it } from 'vitest';

import { createVoivoxLoopbackServer, type VoivoxLoopbackServer } from '../src/loopback-server.js';

describe('VOIVOX loopback API', () => {
  let server: VoivoxLoopbackServer | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it('keeps capture controls behind the local bearer token', async () => {
    server = await createVoivoxLoopbackServer({ token: 'only-on-this-machine' });

    const health = await fetch(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ service: 'voivox', status: 'ready' });

    const unauthorized = await fetch(`${server.baseUrl}/v1/captures`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'chrome-tab', label: 'Demo tab' } })
    });
    expect(unauthorized.status).toBe(401);

    const created = await fetch(`${server.baseUrl}/v1/captures`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer only-on-this-machine',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ source: { kind: 'chrome-tab', label: 'Demo tab' } })
    });

    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      status: 'capturing',
      source: { kind: 'chrome-tab', label: 'Demo tab' }
    });
  });

  it('accepts ASR segments and exports the immutable raw transcript', async () => {
    server = await createVoivoxLoopbackServer({ token: 'only-on-this-machine' });
    const headers = {
      authorization: 'Bearer only-on-this-machine',
      'content-type': 'application/json'
    };
    const created = await fetch(`${server.baseUrl}/v1/captures`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: { kind: 'macos-process', label: 'Safari' } })
    });
    const session = (await created.json()) as { id: string };

    const added = await fetch(`${server.baseUrl}/v1/captures/${session.id}/segments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ startMs: 0, endMs: 600, text: '可以静音收录。' })
    });
    expect(added.status).toBe(204);

    const stopped = await fetch(`${server.baseUrl}/v1/captures/${session.id}/stop`, {
      method: 'POST',
      headers
    });
    expect(await stopped.json()).toMatchObject({ status: 'complete' });

    const exportResponse = await fetch(`${server.baseUrl}/v1/sessions/${session.id}/export`, {
      headers: { authorization: 'Bearer only-on-this-machine' }
    });
    expect(exportResponse.headers.get('content-type')).toContain('text/plain');
    expect(await exportResponse.text()).toBe('[00:00.000 → 00:00.600] 可以静音收录。\n');
  });

  it('serves Codex-facing session status and stores text-only derived output', async () => {
    server = await createVoivoxLoopbackServer({ token: 'only-on-this-machine' });
    const headers = {
      authorization: 'Bearer only-on-this-machine',
      'content-type': 'application/json'
    };
    const created = await fetch(`${server.baseUrl}/v1/captures`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: { kind: 'chrome-tab', label: 'Demo tab' } })
    });
    const session = (await created.json()) as { id: string };

    const status = await fetch(`${server.baseUrl}/v1/status`, { headers });
    expect(await status.json()).toMatchObject({ activeSession: { id: session.id } });

    const derived = await fetch(`${server.baseUrl}/v1/sessions/${session.id}/derived`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'deepseek',
        instruction: '只添加标点。',
        text: '可以 静音 收录'
      })
    });
    expect(derived.status).toBe(201);

    const detail = await fetch(`${server.baseUrl}/v1/sessions/${session.id}`, { headers });
    expect(await detail.json()).toMatchObject({
      rawSegments: [],
      derivedTranscripts: [{ provider: 'deepseek', text: '可以 静音 收录' }]
    });
  });

  it('accepts Chrome bridge audio with a restricted extension token', async () => {
    const receivedChunks: Array<{ sessionId: string; pcm: Uint8Array; sampleRate: 16_000; channels: 1 }> = [];
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'chrome-bridge-token',
      onAudioChunk: (chunk) => {
        receivedChunks.push(chunk);
      }
    });
    const headers = {
      authorization: 'Bearer chrome-bridge-token',
      'content-type': 'application/json'
    };

    const created = await fetch(`${server.baseUrl}/v1/extension/captures`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: { kind: 'chrome-tab', label: 'Current tab' } })
    });
    const session = (await created.json()) as { id: string };

    const chunk = await fetch(`${server.baseUrl}/v1/extension/captures/${session.id}/audio`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        encoding: 'pcm-s16le',
        sampleRate: 16_000,
        channels: 1,
        data: 'AACAgH//'
      })
    });
    expect(chunk.status).toBe(204);
    expect(receivedChunks).toEqual([
      { sessionId: session.id, pcm: new Uint8Array([0, 0, 128, 128, 127, 255]), sampleRate: 16_000, channels: 1 }
    ]);

    const rejected = await fetch(`${server.baseUrl}/v1/sessions`, { headers });
    expect(rejected.status).toBe(401);
  });

  it('flushes the local ASR pipeline before a capture is marked complete', async () => {
    const stopping: string[] = [];
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      onCaptureStopping: async (sessionId) => {
        stopping.push(sessionId);
      }
    });
    const headers = {
      authorization: 'Bearer desktop-only-token',
      'content-type': 'application/json'
    };
    const created = await fetch(`${server.baseUrl}/v1/captures`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: { kind: 'microphone', label: 'Internal microphone' } })
    });
    const session = (await created.json()) as { id: string };

    const stopped = await fetch(`${server.baseUrl}/v1/captures/${session.id}/stop`, {
      method: 'POST',
      headers
    });

    expect(stopped.status).toBe(200);
    expect(stopping).toEqual([session.id]);
  });

  it('does not let the Chrome bridge token inject into or stop a desktop session', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'chrome-bridge-token'
    });
    const desktopHeaders = {
      authorization: 'Bearer desktop-only-token',
      'content-type': 'application/json'
    };
    const extensionHeaders = {
      authorization: 'Bearer chrome-bridge-token',
      'content-type': 'application/json'
    };
    const created = await fetch(`${server.baseUrl}/v1/captures`, {
      method: 'POST',
      headers: desktopHeaders,
      body: JSON.stringify({ source: { kind: 'macos-process', label: 'Safari', processId: 42 } })
    });
    const session = (await created.json()) as { id: string };

    const audio = await fetch(`${server.baseUrl}/v1/extension/captures/${session.id}/audio`, {
      method: 'POST',
      headers: extensionHeaders,
      body: JSON.stringify({
        encoding: 'pcm-s16le',
        sampleRate: 16_000,
        channels: 1,
        data: 'AACAgH//'
      })
    });
    const stopped = await fetch(`${server.baseUrl}/v1/extension/captures/${session.id}/stop`, {
      method: 'POST',
      headers: extensionHeaders
    });

    expect(audio.status).toBe(404);
    expect(stopped.status).toBe(404);
    const status = await fetch(`${server.baseUrl}/v1/status`, { headers: desktopHeaders });
    expect(await status.json()).toMatchObject({ activeSession: { id: session.id, status: 'capturing' } });
  });

  it('starts a selected macOS process through the primary local API only', async () => {
    const started: Array<{ id: string; processId?: number }> = [];
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      onCaptureStarted: (session) => {
        started.push({ id: session.id, processId: session.source.processId });
      }
    });
    const headers = {
      authorization: 'Bearer desktop-only-token',
      'content-type': 'application/json'
    };

    const created = await fetch(`${server.baseUrl}/v1/captures`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: { kind: 'macos-process', label: 'Safari', processId: 42 } })
    });
    const session = (await created.json()) as { id: string };

    expect(started).toEqual([{ id: session.id, processId: 42 }]);
  });
});
