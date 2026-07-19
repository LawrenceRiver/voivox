import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createVoivoxLoopbackServer,
  VOIVOX_EXTENSION_ORIGIN,
  type VoivoxLoopbackServer
} from '../src/loopback-server.js';
import { VoiceVacError } from '../src/voice-vac-error.js';

describe('Voice Vac loopback API', () => {
  let server: VoivoxLoopbackServer | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it('keeps capture controls behind the local bearer token', async () => {
    server = await createVoivoxLoopbackServer({ token: 'only-on-this-machine' });

    const health = await fetch(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      service: 'voivox',
      status: 'ready',
      version: '0.1.1',
      capabilities: { extensionDiscovery: false, localAsr: 'missing' }
    });

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

  it('coordinates a browser nozzle and desktop capsule through tunnel sessions', async () => {
    server = await createVoivoxLoopbackServer({ token: 'desktop-only-token', extensionToken: 'chrome-bridge-token' });
    const desktopHeaders = { authorization: 'Bearer desktop-only-token', 'content-type': 'application/json' };
    const extensionHeaders = {
      authorization: 'Bearer chrome-bridge-token',
      'content-type': 'application/json',
      origin: VOIVOX_EXTENSION_ORIGIN
    };
    const created = await fetch(`${server.baseUrl}/v1/extension/tunnel-sessions`, {
      method: 'POST', headers: extensionHeaders,
      body: JSON.stringify({
        tabId: 9,
        frameId: 0,
        documentId: 'doc-9',
        dropToken: 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        title: 'Demo MV',
        state: 'detecting'
      })
    });
    expect(created.status).toBe(201);
    const session = await created.json() as { id: string };
    const updated = await fetch(`${server.baseUrl}/v1/tunnel-sessions/${session.id}`, {
      method: 'PATCH', headers: desktopHeaders,
      body: JSON.stringify({
        errorCode: 'TARGET_NAVIGATED',
        state: 'ready',
        targetRect: { x: 20, y: 30, width: 640, height: 360 },
        pageEndpoint: { screenX: 340, screenY: 76 }
      })
    });
    expect(await updated.json()).toMatchObject({
      errorCode: 'TARGET_NAVIGATED',
      id: session.id,
      state: 'ready',
      tabId: 9
    });
    const listed = await fetch(`${server.baseUrl}/v1/tunnel-sessions`, { headers: desktopHeaders });
    expect(await listed.json()).toMatchObject({ sessions: [{ id: session.id, state: 'ready' }] });
    const deleted = await fetch(`${server.baseUrl}/v1/tunnel-sessions/${session.id}`, { method: 'DELETE', headers: desktopHeaders });
    expect(deleted.status).toBe(204);
  });

  it('requires fixed Chrome identity on create and rejects identity fields on patch', async () => {
    server = await createVoivoxLoopbackServer({ token: 'desktop-only-token', extensionToken: 'chrome-bridge-token' });
    const extensionHeaders = {
      authorization: 'Bearer chrome-bridge-token',
      'content-type': 'application/json',
      origin: VOIVOX_EXTENSION_ORIGIN
    };
    const missingIdentity = await fetch(`${server.baseUrl}/v1/extension/tunnel-sessions`, {
      method: 'POST', headers: extensionHeaders, body: JSON.stringify({ tabId: 9 })
    });
    expect(missingIdentity.status).toBe(400);

    const created = await fetch(`${server.baseUrl}/v1/extension/tunnel-sessions`, {
      method: 'POST', headers: extensionHeaders,
      body: JSON.stringify({
        tabId: 9,
        frameId: 0,
        documentId: 'doc-9',
        dropToken: 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      })
    });
    const session = await created.json() as { id: string };
    const retarget = await fetch(`${server.baseUrl}/v1/extension/tunnel-sessions/${session.id}`, {
      method: 'PATCH', headers: extensionHeaders,
      body: JSON.stringify({ documentId: 'doc-other', frameId: 7, tabId: 99 })
    });
    expect(retarget.status).toBe(400);
  });

  it('restricts the extension token to completed text imports and refuses Chrome audio routes', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'chrome-bridge-token'
    });
    const headers = {
      authorization: 'Bearer chrome-bridge-token',
      'content-type': 'application/json',
      origin: VOIVOX_EXTENSION_ORIGIN
    };

    const created = await fetch(`${server.baseUrl}/v1/extension/captures`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: { kind: 'chrome-tab', label: 'Current tab' } })
    });
    const chunk = await fetch(`${server.baseUrl}/v1/extension/captures/obsolete-session/audio`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        encoding: 'pcm-s16le',
        sampleRate: 16_000,
        channels: 1,
        data: 'AACAgH//'
      })
    });
    const stopped = await fetch(`${server.baseUrl}/v1/extension/captures/obsolete-session/stop`, {
      method: 'POST',
      headers
    });

    expect(created.status).toBe(404);
    expect(chunk.status).toBe(404);
    expect(stopped.status).toBe(404);

    const rejected = await fetch(`${server.baseUrl}/v1/sessions`, { headers });
    expect(rejected.status).toBe(401);
  });

  it('imports browser-local transcript text for MCP without uploading audio', async () => {
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
      'content-type': 'application/json',
      origin: VOIVOX_EXTENSION_ORIGIN
    };
    const activeResponse = await fetch(`${server.baseUrl}/v1/captures`, {
      method: 'POST',
      headers: desktopHeaders,
      body: JSON.stringify({ source: { kind: 'macos-process', label: 'Music', processId: 42 } })
    });
    const active = await activeResponse.json() as { id: string };

    const importedResponse = await fetch(`${server.baseUrl}/v1/extension/transcripts`, {
      method: 'POST',
      headers: extensionHeaders,
      body: JSON.stringify({
        source: { kind: 'chrome-tab', label: 'My MV' },
        durationMs: 12_500,
        transcript: '这是 Chrome 内置本地模型的转写。'
      })
    });
    const imported = await importedResponse.json() as { id: string };

    expect(importedResponse.status).toBe(201);
    expect(imported).toMatchObject({
      source: { kind: 'chrome-tab', label: 'My MV' },
      status: 'complete',
      rawSegments: [{ startMs: 0, endMs: 12_500, text: '这是 Chrome 内置本地模型的转写。' }]
    });

    const sessionsResponse = await fetch(`${server.baseUrl}/v1/sessions`, { headers: desktopHeaders });
    const sessionsBody = await sessionsResponse.json() as { sessions: Array<{ id: string }> };
    expect(sessionsBody.sessions.map((session) => session.id)).toEqual([imported.id, active.id]);
    const statusResponse = await fetch(`${server.baseUrl}/v1/status`, { headers: desktopHeaders });
    expect(await statusResponse.json()).toMatchObject({ activeSession: { id: active.id } });
  });

  it.each([
    { source: { kind: 'macos-process', label: 'Safari' }, durationMs: 1_000, transcript: 'text' },
    { source: { kind: 'chrome-tab', label: 'Tab' }, durationMs: -1, transcript: 'text' },
    { source: { kind: 'chrome-tab', label: 'Tab' }, durationMs: 600_001, transcript: 'text' },
    { source: { kind: 'chrome-tab', label: 'Tab' }, durationMs: 1_000, transcript: '   ' }
  ])('rejects an invalid browser-local transcript import: %o', async (body) => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'chrome-bridge-token'
    });

    const response = await fetch(`${server.baseUrl}/v1/extension/transcripts`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer chrome-bridge-token',
        'content-type': 'application/json',
        origin: VOIVOX_EXTENSION_ORIGIN
      },
      body: JSON.stringify(body)
    });

    expect(response.status).toBe(400);
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
      'content-type': 'application/json',
      origin: VOIVOX_EXTENSION_ORIGIN
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

  it('listens on an optional fixed loopback port', async () => {
    const port = await reserveAvailablePort();

    server = await createVoivoxLoopbackServer({ token: 'desktop-only-token', port });

    expect(server.baseUrl).toBe(`http://127.0.0.1:${port}`);
  });

  it('reports version and live desktop capabilities without exposing a bearer token', async () => {
    let localAsr: 'checking' | 'ready' | 'missing' = 'checking';
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'restricted-extension-token',
      capabilities: () => ({ extensionDiscovery: true, localAsr })
    });

    const first = await fetch(`${server.baseUrl}/health`, {
      headers: { origin: VOIVOX_EXTENSION_ORIGIN }
    });
    expect(first.headers.get('access-control-allow-origin')).toBe(VOIVOX_EXTENSION_ORIGIN);
    expect(await first.json()).toEqual({
      service: 'voivox',
      status: 'ready',
      version: '0.1.1',
      capabilities: { extensionDiscovery: true, localAsr: 'checking' }
    });

    localAsr = 'ready';
    const second = await fetch(`${server.baseUrl}/health`);
    const body = await second.json() as Record<string, unknown>;
    expect(body).toMatchObject({ capabilities: { extensionDiscovery: true, localAsr: 'ready' } });
    expect(JSON.stringify(body)).not.toContain('desktop-only-token');
    expect(JSON.stringify(body)).not.toContain('restricted-extension-token');
  });

  it('proves the live MCP server identity with the primary token without exposing it', async () => {
    const challenge = 'M'.repeat(43);
    server = await createVoivoxLoopbackServer({ token: 'primary-token-must-stay-private' });

    const response = await fetch(
      `${server.baseUrl}/v1/mcp/proof?challenge=${challenge}`
    );
    const body = await response.json() as Record<string, unknown>;
    const expectedProof = createHmac('sha256', 'primary-token-must-stay-private')
      .update(`voivox-mcp-proof\n1\n${challenge}\n${server.baseUrl}`)
      .digest('base64url');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({
      baseUrl: server.baseUrl,
      proof: expectedProof,
      protocolVersion: 1,
      service: 'voivox',
      status: 'ready'
    });
    expect(JSON.stringify(body)).not.toContain('primary-token-must-stay-private');
  });

  it.each([
    '',
    'M'.repeat(42),
    'M'.repeat(44),
    `${'M'.repeat(42)}=`,
    `${'M'.repeat(42)}!`
  ])('strictly rejects an invalid MCP proof challenge: %s', async (challenge) => {
    server = await createVoivoxLoopbackServer({ token: 'primary-token-must-stay-private' });

    const response = await fetch(
      `${server.baseUrl}/v1/mcp/proof?challenge=${encodeURIComponent(challenge)}`
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain('primary-token-must-stay-private');
  });

  it('rejects ambiguous MCP proof queries and non-GET requests', async () => {
    server = await createVoivoxLoopbackServer({ token: 'primary-token-must-stay-private' });
    const challenge = 'N'.repeat(43);

    const ambiguous = await fetch(
      `${server.baseUrl}/v1/mcp/proof?challenge=${challenge}&challenge=${challenge}`
    );
    const wrongMethod = await fetch(
      `${server.baseUrl}/v1/mcp/proof?challenge=${challenge}`,
      { method: 'POST' }
    );

    expect(ambiguous.status).toBe(400);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET');
  });

  it('proves the live server identity without receiving or exposing either bearer token', async () => {
    const challenge = 'A'.repeat(43);
    server = await createVoivoxLoopbackServer({
      token: 'primary-token-must-stay-private',
      extensionToken: 'restricted-extension-token'
    });

    const response = await fetch(
      `${server.baseUrl}/v1/native/proof?challenge=${challenge}`
    );
    const body = await response.json() as Record<string, unknown>;
    const expectedProof = createHmac('sha256', 'restricted-extension-token')
      .update(`voivox-native-proof\n1\n${challenge}\n${server.baseUrl}`)
      .digest('base64url');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({
      baseUrl: server.baseUrl,
      proof: expectedProof,
      protocolVersion: 1,
      service: 'voivox',
      status: 'ready'
    });
    expect(JSON.stringify(body)).not.toContain('primary-token-must-stay-private');
    expect(JSON.stringify(body)).not.toContain('restricted-extension-token');
    expect(JSON.stringify(body)).not.toContain('segments');
  });

  it.each([
    '',
    'A'.repeat(42),
    'A'.repeat(44),
    `${'A'.repeat(42)}=`,
    `${'A'.repeat(42)}!`
  ])('strictly rejects an invalid native proof challenge: %s', async (challenge) => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'restricted-extension-token'
    });

    const response = await fetch(
      `${server.baseUrl}/v1/native/proof?challenge=${encodeURIComponent(challenge)}`
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain('restricted-extension-token');
  });

  it('rejects ambiguous native proof queries and refuses proof without an extension secret', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'restricted-extension-token'
    });
    const challenge = 'B'.repeat(43);
    const ambiguous = await fetch(
      `${server.baseUrl}/v1/native/proof?challenge=${challenge}&challenge=${challenge}`
    );
    expect(ambiguous.status).toBe(400);

    await server.close();
    server = await createVoivoxLoopbackServer({ token: 'desktop-only-token' });
    const unavailable = await fetch(
      `${server.baseUrl}/v1/native/proof?challenge=${challenge}`
    );
    expect(unavailable.status).toBe(503);
  });

  it('rejects missing or unknown origins before any extension endpoint behavior', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'restricted-extension-token'
    });

    const missingOrigin = await fetch(`${server.baseUrl}/v1/extension/bootstrap`, { method: 'POST' });
    const unknownOrigin = await fetch(`${server.baseUrl}/v1/extension/not-a-real-endpoint`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer restricted-extension-token',
        origin: 'chrome-extension://not-voivox'
      }
    });

    expect(missingOrigin.status).toBe(403);
    expect(unknownOrigin.status).toBe(403);
    expect(unknownOrigin.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never exposes the restricted extension token over HTTP', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'restricted-extension-token'
    });

    const response = await fetch(`${server.baseUrl}/v1/extension/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer restricted-extension-token',
        origin: VOIVOX_EXTENSION_ORIGIN
      }
    });

    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('restricted-extension-token');
  });

  it('answers extension CORS preflight only for the stable extension origin', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'restricted-extension-token'
    });

    const allowed = await fetch(`${server.baseUrl}/v1/extension/transcripts`, {
      method: 'OPTIONS',
      headers: {
        origin: VOIVOX_EXTENSION_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type'
      }
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(VOIVOX_EXTENSION_ORIGIN);
    expect(allowed.headers.get('access-control-allow-methods')).toContain('POST');
    expect(allowed.headers.get('access-control-allow-headers')).toContain('authorization');

    const denied = await fetch(`${server.baseUrl}/v1/extension/transcripts`, {
      method: 'OPTIONS',
      headers: {
        origin: 'chrome-extension://not-voivox',
        'access-control-request-method': 'POST'
      }
    });
    expect(denied.status).toBe(403);
  });

  it('rejects oversized JSON before parsing or storing it', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      extensionToken: 'restricted-extension-token'
    });

    const response = await fetch(`${server.baseUrl}/v1/extension/transcripts`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer restricted-extension-token',
        'content-type': 'application/json',
        origin: VOIVOX_EXTENSION_ORIGIN
      },
      body: JSON.stringify({
        durationMs: 1_000,
        source: { kind: 'chrome-tab', label: 'Oversized tab' },
        transcript: 'x'.repeat(1_600_000)
      })
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Voice Vac JSON request body is too large.'
    });
  });

  it('returns a typed operational failure without exposing its cause', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      onActiveVideoTranscription: async () => {
        throw new VoiceVacError(
          'TARGET_NAVIGATED',
          'The armed video navigated. Arm the current page again.',
          true,
          409,
          Object.assign(new Error('private target URL'), { stderr: 'secret worker output' })
        );
      }
    });

    const response = await fetch(`${server.baseUrl}/v1/transcriptions/active-video`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer desktop-only-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        language: 'auto',
        mode: 'auto',
        output_format: 'text',
        timestamps: false
      })
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toEqual({
      code: 'TARGET_NAVIGATED',
      error: 'The armed page navigated. Arm the current page again.',
      retryable: true
    });
    expect(JSON.stringify(body)).not.toMatch(/private target|stderr|worker output/iu);
  });

  it('redacts unknown exceptions behind a generic typed 500', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      onActiveVideoTranscription: async () => {
        throw Object.assign(new Error('Bearer private-token'), {
          stderr: '/Users/private/model stderr',
          stdout: 'secret protocol frame'
        });
      }
    });

    const response = await fetch(`${server.baseUrl}/v1/transcriptions/active-video`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer desktop-only-token',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        language: 'auto',
        mode: 'auto',
        output_format: 'text',
        timestamps: false
      })
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      code: 'INTERNAL_ERROR',
      error: 'Voice VAC could not complete the request.',
      retryable: false
    });
    expect(JSON.stringify(body)).not.toMatch(/private|stderr|stdout|protocol|Bearer/iu);
  });
});

async function reserveAvailablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not reserve a test port.');
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}
