import { createHmac } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTranscriptResult,
  createVoivoxLoopbackServer,
  type VoivoxLoopbackServer
} from '@voivox/core';
import { parseVoivoxConnection } from '../src/index.js';
import { VoivoxClient } from '../src/voivox-client.js';

describe('VoivoxClient', () => {
  let server: VoivoxLoopbackServer | undefined;
  let stalledServer: Server | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    stalledServer?.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      if (!stalledServer?.listening) {
        resolve();
        return;
      }
      stalledServer.close((error) => error ? reject(error) : resolve());
    });
    stalledServer = undefined;
  });

  it('uses the desktop app token to start and read a local capture', async () => {
    server = await createVoivoxLoopbackServer({ token: 'desktop-only-token' });
    const client = new VoivoxClient({ baseUrl: server.baseUrl, token: 'desktop-only-token' });

    const started = await client.startCapture({ kind: 'microphone', label: 'Internal microphone' });
    const status = await client.status();

    expect(started).toMatchObject({ status: 'capturing' });
    expect(status).toMatchObject({ activeSession: { id: started.id } });
  });

  it('uses the long capture deadline for active-video transcription', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      onActiveVideoTranscription: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return createTranscriptResult({
          language: 'zh',
          processing_mode: 'live_tunnel',
          segments: [{ start: 0, end: 1, text: '当前视频' }],
          title: 'Current video',
          transcript: '当前视频'
        });
      }
    });
    const client = new VoivoxClient(
      { baseUrl: server.baseUrl, token: 'desktop-only-token' },
      { captureStopTimeoutMs: 100, requestTimeoutMs: 10 }
    );

    await expect(client.transcribeActiveVideo({
      language: 'auto',
      mode: 'auto',
      output_format: 'text',
      timestamps: false
    })).resolves.toMatchObject({ transcript: '当前视频' });
  });

  it('lists selectable macOS processes without granting the Chrome bridge that capability', async () => {
    server = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      listMacProcesses: async () => [{ bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 }]
    });
    const client = new VoivoxClient({ baseUrl: server.baseUrl, token: 'desktop-only-token' });

    await expect(client.listMacProcesses()).resolves.toEqual([
      { bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 }
    ]);
  });

  it('proves the live server before sending the bearer token', async () => {
    const requests: Array<{ authorization?: string; path: string }> = [];
    let baseUrl = '';
    stalledServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', baseUrl);
      requests.push({
        authorization: request.headers.authorization,
        path: url.pathname
      });
      if (url.pathname === '/v1/mcp/proof') {
        const challenge = url.searchParams.get('challenge') ?? '';
        sendJson(response, 200, validProofBody(baseUrl, 'desktop-only-token', challenge), {
          'cache-control': 'no-store'
        });
        return;
      }
      sendJson(response, 200, { sessionCount: 0 });
    });
    baseUrl = await listen(stalledServer);
    const client = new VoivoxClient({ baseUrl, token: 'desktop-only-token' });

    await expect(client.status()).resolves.toEqual({ sessionCount: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({ authorization: undefined, path: '/v1/mcp/proof' });
    expect(requests[1]).toEqual({
      authorization: 'Bearer desktop-only-token',
      path: '/v1/status'
    });
  });

  it('rejects a stale-port impersonator without exposing Authorization', async () => {
    const observedAuthorization: Array<string | undefined> = [];
    let baseUrl = '';
    stalledServer = createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization);
      const url = new URL(request.url ?? '/', baseUrl);
      if (url.pathname === '/v1/mcp/proof') {
        sendJson(response, 200, {
          baseUrl,
          proof: 'A'.repeat(43),
          protocolVersion: 1,
          service: 'voivox',
          status: 'ready'
        }, { 'cache-control': 'no-store' });
        return;
      }
      sendJson(response, 200, { sessionCount: 999 });
    });
    baseUrl = await listen(stalledServer);
    const client = new VoivoxClient({ baseUrl, token: 'desktop-only-token' });

    await expect(client.status()).rejects.toThrow(/proof|identity/i);
    expect(observedAuthorization).toEqual([undefined]);
  });

  it('rejects an oversized declared proof body before waiting for payload completion', async () => {
    const observedAuthorization: Array<string | undefined> = [];
    stalledServer = createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': '5000',
        'content-type': 'application/json'
      });
      response.write('{');
    });
    const baseUrl = await listen(stalledServer);
    const client = new VoivoxClient(
      { baseUrl, token: 'desktop-only-token' },
      { requestTimeoutMs: 1_000 }
    );

    const outcome = await settleBefore(client.status(), 250);
    expect(outcome).toMatch(/proof|identity/i);
    expect(observedAuthorization).toEqual([undefined]);
  });

  it('cancels an oversized chunked proof body without buffering the remaining stream', async () => {
    const observedAuthorization: Array<string | undefined> = [];
    stalledServer = createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'transfer-encoding': 'chunked'
      });
      response.write('x'.repeat(4_097));
    });
    const baseUrl = await listen(stalledServer);
    const client = new VoivoxClient(
      { baseUrl, token: 'desktop-only-token' },
      { requestTimeoutMs: 1_000 }
    );

    const outcome = await settleBefore(client.status(), 250);
    expect(outcome).toMatch(/proof|identity/i);
    expect(observedAuthorization).toEqual([undefined]);
  });

  it.each([
    ['wrong service', { service: 'not-voivox' }],
    ['wrong protocol version', { protocolVersion: 2 }],
    ['wrong base URL', { baseUrl: 'http://127.0.0.1:65535' }],
    ['malformed proof', { proof: 'not-a-proof' }],
    ['unexpected field', { extra: 'must-be-rejected' }]
  ])('rejects a strict MCP proof with %s before Authorization', async (_label, override) => {
    const observedAuthorization: Array<string | undefined> = [];
    let baseUrl = '';
    stalledServer = createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization);
      const url = new URL(request.url ?? '/', baseUrl);
      if (url.pathname === '/v1/mcp/proof') {
        const challenge = url.searchParams.get('challenge') ?? '';
        sendJson(response, 200, {
          ...validProofBody(baseUrl, 'desktop-only-token', challenge),
          ...override
        }, { 'cache-control': 'no-store' });
        return;
      }
      sendJson(response, 200, { sessionCount: 0 });
    });
    baseUrl = await listen(stalledServer);
    const client = new VoivoxClient({ baseUrl, token: 'desktop-only-token' });

    await expect(client.status()).rejects.toThrow(/proof|identity/i);
    expect(observedAuthorization).toEqual([undefined]);
  });

  it('rejects a replayed proof before sending a second Authorization header', async () => {
    const observedAuthorization: Array<string | undefined> = [];
    let baseUrl = '';
    let firstProof: string | undefined;
    stalledServer = createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization);
      const url = new URL(request.url ?? '/', baseUrl);
      if (url.pathname === '/v1/mcp/proof') {
        const challenge = url.searchParams.get('challenge') ?? '';
        const currentProof = validProofBody(baseUrl, 'desktop-only-token', challenge);
        firstProof ??= currentProof.proof;
        sendJson(
          response,
          200,
          { ...currentProof, proof: firstProof },
          { 'cache-control': 'no-store' }
        );
        return;
      }
      sendJson(response, 200, { sessionCount: 0 });
    });
    baseUrl = await listen(stalledServer);
    const client = new VoivoxClient({ baseUrl, token: 'desktop-only-token' });

    await expect(client.status()).resolves.toEqual({ sessionCount: 0 });
    await expect(client.status()).rejects.toThrow(/proof|identity/i);
    expect(observedAuthorization).toEqual([
      undefined,
      'Bearer desktop-only-token',
      undefined
    ]);
  });

  it('re-proves after a legitimate server is replaced on the same port', async () => {
    server = await createVoivoxLoopbackServer({ token: 'desktop-only-token' });
    const connection = { baseUrl: server.baseUrl, token: 'desktop-only-token' };
    const client = new VoivoxClient(connection);
    await expect(client.status()).resolves.toEqual({ sessionCount: 0 });
    const port = Number(new URL(server.baseUrl).port);
    await server.close();
    server = undefined;

    const observedAuthorization: Array<string | undefined> = [];
    stalledServer = createServer((request, response) => {
      observedAuthorization.push(request.headers.authorization);
      const url = new URL(request.url ?? '/', connection.baseUrl);
      if (url.pathname === '/v1/mcp/proof') {
        sendJson(response, 200, {
          baseUrl: connection.baseUrl,
          proof: 'A'.repeat(43),
          protocolVersion: 1,
          service: 'voivox',
          status: 'ready'
        }, { 'cache-control': 'no-store' });
        return;
      }
      sendJson(response, 200, { sessionCount: 777 });
    });
    await listen(stalledServer, port);

    await expect(client.status()).rejects.toThrow();
    await expect(client.status()).rejects.toThrow(/proof|identity/i);
    expect(observedAuthorization.length).toBeGreaterThan(0);
    expect(observedAuthorization.every((authorization) => authorization === undefined)).toBe(true);
  });

  it('single-flights only simultaneous proof checks', async () => {
    let proofRequests = 0;
    let authorizedRequests = 0;
    let baseUrl = '';
    stalledServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', baseUrl);
      if (url.pathname === '/v1/mcp/proof') {
        proofRequests += 1;
        const challenge = url.searchParams.get('challenge') ?? '';
        sendJson(
          response,
          200,
          validProofBody(baseUrl, 'desktop-only-token', challenge),
          { 'cache-control': 'no-store' }
        );
        return;
      }
      if (request.headers.authorization === 'Bearer desktop-only-token') {
        authorizedRequests += 1;
      }
      sendJson(response, 200, url.pathname === '/v1/sessions'
        ? { sessions: [] }
        : { sessionCount: 0 });
    });
    baseUrl = await listen(stalledServer);
    const client = new VoivoxClient({ baseUrl, token: 'desktop-only-token' });

    await Promise.all([client.status(), client.listSessions()]);
    expect(proofRequests).toBe(1);
    expect(authorizedRequests).toBe(2);
  });

  it('aborts a local request when the desktop app does not answer before the configured timeout', async () => {
    stalledServer = createServer(() => undefined);
    await new Promise<void>((resolve) => stalledServer!.listen(0, '127.0.0.1', resolve));
    const address = stalledServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a local TCP address.');
    }
    const client = new VoivoxClient(
      { baseUrl: `http://127.0.0.1:${address.port}`, token: 'desktop-only-token' },
      { requestTimeoutMs: 25 }
    );

    const outcome = await Promise.race([
      client.status().then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error)
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 250))
    ]);

    expect(outcome).toBe('Voice Vac desktop app did not respond within 25 ms.');
  });
});

function validProofBody(baseUrl: string, token: string, challenge: string) {
  return {
    baseUrl,
    proof: createHmac('sha256', token)
      .update(`voivox-mcp-proof\n1\n${challenge}\n${baseUrl}`)
      .digest('base64url'),
    protocolVersion: 1,
    service: 'voivox',
    status: 'ready'
  };
}

function listen(server: Server, port = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected a local TCP address.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

async function settleBefore(promise: Promise<unknown>, timeoutMs: number): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error)
      ),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve('still pending'), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

describe('parseVoivoxConnection', () => {
  it('accepts only an exact IPv4 loopback base URL and a non-empty bearer token', () => {
    expect(parseVoivoxConnection({
      baseUrl: 'http://127.0.0.1:43817',
      token: 'desktop-only-token'
    })).toEqual({
      baseUrl: 'http://127.0.0.1:43817',
      token: 'desktop-only-token'
    });

    for (const baseUrl of [
      'https://127.0.0.1:43817',
      'http://localhost:43817',
      'http://127.0.0.1:43817/path',
      'http://127.0.0.1:43817?token=leak',
      'http://example.com:43817'
    ]) {
      expect(() => parseVoivoxConnection({ baseUrl, token: 'desktop-only-token' }))
        .toThrow('Voice Vac desktop connection file is invalid');
    }
    expect(() => parseVoivoxConnection({
      baseUrl: 'http://127.0.0.1:43817',
      token: ''
    })).toThrow('Voice Vac desktop connection file is invalid');
  });
});
