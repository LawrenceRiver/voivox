import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { type CaptureSession, VoivoxService } from './voivox-service.js';

export const VOIVOX_EXTENSION_ORIGIN = 'chrome-extension://pepfpbobjbjehhhcjiokmneclohlffno';
export const VOIVOX_VERSION = '0.1.1';
const NATIVE_PROOF_PATH = '/v1/native/proof';
const NATIVE_PROOF_PROTOCOL_VERSION = 1;
const NATIVE_PROOF_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MCP_PROOF_PATH = '/v1/mcp/proof';
const MCP_PROOF_PROTOCOL_VERSION = 1;
const MCP_PROOF_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MAXIMUM_JSON_BODY_BYTES = 1_500_000;

export type LocalAsrStatus = 'checking' | 'ready' | 'missing';

export type VoivoxCapabilities = {
  extensionDiscovery: boolean;
  localAsr: LocalAsrStatus;
};

export type VoivoxLoopbackServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

export type MacAudioProcess = {
  bundleId: string;
  name: string;
  pid: number;
};

export async function createVoivoxLoopbackServer(options: {
  token: string;
  port?: number;
  service?: VoivoxService;
  extensionToken?: string;
  capabilities?: VoivoxCapabilities | (() => VoivoxCapabilities);
  listMacProcesses?: () => Promise<MacAudioProcess[]>;
  onCaptureStarted?: (session: CaptureSession) => void | Promise<void>;
  onCaptureStopping?: (sessionId: string) => void | Promise<void>;
}): Promise<VoivoxLoopbackServer> {
  const service = options.service ?? new VoivoxService();
  let actualBaseUrl: string | undefined;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        if (request.headers.origin === VOIVOX_EXTENSION_ORIGIN) {
          applyExtensionCors(response);
        }
        sendJson(response, 200, {
          service: 'voivox',
          status: 'ready',
          version: VOIVOX_VERSION,
          capabilities: resolveCapabilities(options.capabilities)
        });
        return;
      }

      const requestUrl = request.url
        ? new URL(request.url, 'http://127.0.0.1')
        : undefined;
      if (requestUrl?.pathname === MCP_PROOF_PATH) {
        if (request.method !== 'GET') {
          response.setHeader('allow', 'GET');
          sendJson(response, 405, { error: 'VOIVOX MCP proof requires GET.' });
          return;
        }
        const challenge = parseMcpProofChallenge(requestUrl);
        if (!challenge) {
          sendJson(response, 400, { error: 'A valid VOIVOX MCP proof challenge is required.' });
          return;
        }
        if (!actualBaseUrl) {
          sendJson(response, 503, { error: 'VOIVOX MCP proof is unavailable.' });
          return;
        }

        const proof = createHmac('sha256', options.token)
          .update(mcpProofMessage(challenge, actualBaseUrl))
          .digest('base64url');
        response.setHeader('cache-control', 'no-store');
        sendJson(response, 200, {
          baseUrl: actualBaseUrl,
          proof,
          protocolVersion: MCP_PROOF_PROTOCOL_VERSION,
          service: 'voivox',
          status: 'ready'
        });
        return;
      }
      if (requestUrl?.pathname === NATIVE_PROOF_PATH) {
        if (request.method !== 'GET') {
          response.setHeader('allow', 'GET');
          sendJson(response, 405, { error: 'VOIVOX native proof requires GET.' });
          return;
        }
        const challenge = parseNativeProofChallenge(requestUrl);
        if (!challenge) {
          sendJson(response, 400, { error: 'A valid VOIVOX native proof challenge is required.' });
          return;
        }
        if (!options.extensionToken || !actualBaseUrl) {
          sendJson(response, 503, { error: 'VOIVOX native proof is unavailable.' });
          return;
        }

        const proof = createHmac('sha256', options.extensionToken)
          .update(nativeProofMessage(challenge, actualBaseUrl))
          .digest('base64url');
        response.setHeader('cache-control', 'no-store');
        sendJson(response, 200, {
          baseUrl: actualBaseUrl,
          proof,
          protocolVersion: NATIVE_PROOF_PROTOCOL_VERSION,
          service: 'voivox',
          status: 'ready'
        });
        return;
      }

      if (request.url?.startsWith('/v1/extension/')) {
        if (request.headers.origin !== VOIVOX_EXTENSION_ORIGIN) {
          sendJson(response, 403, { error: 'This VOIVOX extension origin is not allowed.' });
          return;
        }
        applyExtensionCors(response);

        if (request.method === 'OPTIONS') {
          response.writeHead(204);
          response.end();
          return;
        }

        if (!options.extensionToken || !isAuthorized(request, options.extensionToken)) {
          sendJson(response, 401, { error: 'VOIVOX Chrome bridge token required.' });
          return;
        }

        if (request.method === 'POST' && request.url === '/v1/extension/transcripts') {
          const body = await readJson(request);
          if (!isBrowserTranscriptImport(body)) {
            sendJson(response, 400, {
              error: 'VOIVOX browser transcript import requires a Chrome tab, local text, and a duration up to 10 minutes.'
            });
            return;
          }

          sendJson(
            response,
            201,
            service.importCompletedCapture(
              body.source,
              [{ startMs: 0, endMs: body.durationMs, text: body.transcript }]
            )
          );
          return;
        }

        sendJson(response, 404, { error: 'Unknown VOIVOX Chrome bridge endpoint.' });
        return;
      }

      if (!isAuthorized(request, options.token)) {
        sendJson(response, 401, { error: 'Local VOIVOX bearer token required.' });
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/status') {
        sendJson(response, 200, {
          activeSession: service.getActiveSession(),
          sessionCount: service.listSessions().length
        });
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/sessions') {
        sendJson(response, 200, { sessions: service.listSessions() });
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/macos-processes') {
        if (!options.listMacProcesses) {
          sendJson(response, 503, { error: 'VOIVOX macOS process capture is not available in this desktop app.' });
          return;
        }
        sendJson(response, 200, { processes: await options.listMacProcesses() });
        return;
      }

      if (request.method === 'POST' && request.url === '/v1/captures') {
        const body = await readJson(request);
        const source = body.source;

        if (!isCaptureSource(source)) {
          sendJson(response, 400, { error: 'A valid capture source is required.' });
          return;
        }

        const session = service.startCapture(source);
        try {
          await options.onCaptureStarted?.(session);
        } catch (error) {
          service.stopCapture(session.id);
          throw error;
        }
        sendJson(response, 201, session);
        return;
      }

      const segmentMatch = request.url?.match(/^\/v1\/captures\/([^/]+)\/segments$/);
      if (request.method === 'POST' && segmentMatch) {
        const body = await readJson(request);
        if (!isRawSegment(body)) {
          sendJson(response, 400, { error: 'A timestamped transcript segment is required.' });
          return;
        }

        service.appendRawSegment(decodeURIComponent(segmentMatch[1]!), body);
        response.writeHead(204);
        response.end();
        return;
      }

      const stopMatch = request.url?.match(/^\/v1\/captures\/([^/]+)\/stop$/);
      if (request.method === 'POST' && stopMatch) {
        const sessionId = decodeURIComponent(stopMatch[1]!);
        await options.onCaptureStopping?.(sessionId);
        const session = service.stopCapture(sessionId);
        sendJson(response, 200, session);
        return;
      }

      const exportMatch = request.url?.match(/^\/v1\/sessions\/([^/]+)\/export$/);
      if (request.method === 'GET' && exportMatch) {
        const session = service.getSession(decodeURIComponent(exportMatch[1]!));
        if (!session) {
          sendJson(response, 404, { error: 'VOIVOX session not found.' });
          return;
        }

        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(formatRawTranscript(session.rawSegments));
        return;
      }

      const derivedMatch = request.url?.match(/^\/v1\/sessions\/([^/]+)\/derived$/);
      if (request.method === 'POST' && derivedMatch) {
        const body = await readJson(request);
        if (!isDerivedTranscript(body)) {
          sendJson(response, 400, { error: 'A provider, instruction, and text-only result are required.' });
          return;
        }

        sendJson(
          response,
          201,
          service.addDerivedTranscript(decodeURIComponent(derivedMatch[1]!), body)
        );
        return;
      }

      const detailMatch = request.url?.match(/^\/v1\/sessions\/([^/]+)$/);
      if (request.method === 'GET' && detailMatch) {
        const session = service.getSession(decodeURIComponent(detailMatch[1]!));
        if (!session) {
          sendJson(response, 404, { error: 'VOIVOX session not found.' });
          return;
        }

        sendJson(response, 200, session);
        return;
      }

      sendJson(response, 404, { error: 'Unknown VOIVOX endpoint.' });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : 'Invalid request.'
      });
    }
  });

  await listen(server, options.port ?? 0);
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('VOIVOX loopback server did not expose a TCP address.');
  }

  actualBaseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl: actualBaseUrl,
    close: () => close(server)
  };
}

function parseMcpProofChallenge(url: URL): string | undefined {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== 'challenge') {
    return undefined;
  }
  const challenge = entries[0][1];
  return MCP_PROOF_CHALLENGE.test(challenge) ? challenge : undefined;
}

function mcpProofMessage(challenge: string, baseUrl: string): string {
  return `voivox-mcp-proof\n${MCP_PROOF_PROTOCOL_VERSION}\n${challenge}\n${baseUrl}`;
}

function parseNativeProofChallenge(url: URL): string | undefined {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== 'challenge') {
    return undefined;
  }
  const challenge = entries[0][1];
  return NATIVE_PROOF_CHALLENGE.test(challenge) ? challenge : undefined;
}

function nativeProofMessage(challenge: string, baseUrl: string): string {
  return `voivox-native-proof\n${NATIVE_PROOF_PROTOCOL_VERSION}\n${challenge}\n${baseUrl}`;
}

function resolveCapabilities(
  capabilities: VoivoxCapabilities | (() => VoivoxCapabilities) | undefined
): VoivoxCapabilities {
  const resolved = typeof capabilities === 'function'
    ? capabilities()
    : capabilities ?? { extensionDiscovery: false, localAsr: 'missing' };
  return { ...resolved };
}

function applyExtensionCors(response: ServerResponse): void {
  response.setHeader('access-control-allow-origin', VOIVOX_EXTENSION_ORIGIN);
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'authorization, content-type');
  response.setHeader('vary', 'Origin');
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function isCaptureSource(value: unknown): value is {
  kind: 'chrome-tab' | 'macos-process' | 'microphone';
  label: string;
  processId?: number;
} {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const source = value as { kind?: unknown; label?: unknown; processId?: unknown };
  return (
    (source.kind === 'chrome-tab' || source.kind === 'macos-process' || source.kind === 'microphone') &&
    typeof source.label === 'string' &&
    source.label.length > 0 &&
    (source.processId === undefined || (typeof source.processId === 'number' && Number.isInteger(source.processId) && source.processId > 0))
  );
}

function isRawSegment(value: unknown): value is {
  startMs: number;
  endMs: number;
  text: string;
} {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const segment = value as { startMs?: unknown; endMs?: unknown; text?: unknown };
  return (
    typeof segment.startMs === 'number' &&
    Number.isFinite(segment.startMs) &&
    segment.startMs >= 0 &&
    typeof segment.endMs === 'number' &&
    Number.isFinite(segment.endMs) &&
    segment.endMs >= segment.startMs &&
    typeof segment.text === 'string'
  );
}

function isDerivedTranscript(value: unknown): value is {
  provider: string;
  instruction: string;
  text: string;
} {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const transcript = value as { provider?: unknown; instruction?: unknown; text?: unknown };
  return (
    typeof transcript.provider === 'string' &&
    transcript.provider.length > 0 &&
    typeof transcript.instruction === 'string' &&
    transcript.instruction.length > 0 &&
    typeof transcript.text === 'string'
  );
}

function isBrowserTranscriptImport(value: unknown): value is {
  source: { kind: 'chrome-tab'; label: string };
  durationMs: number;
  transcript: string;
} {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const body = value as {
    source?: unknown;
    durationMs?: unknown;
    transcript?: unknown;
  };
  return (
    isCaptureSource(body.source) &&
    body.source.kind === 'chrome-tab' &&
    body.source.label.length <= 200 &&
    typeof body.durationMs === 'number' &&
    Number.isInteger(body.durationMs) &&
    body.durationMs >= 0 &&
    body.durationMs <= 600_000 &&
    typeof body.transcript === 'string' &&
    body.transcript.trim().length > 0 &&
    body.transcript.length <= 200_000
  );
}

function formatRawTranscript(
  segments: Array<{ startMs: number; endMs: number; text: string }>
): string {
  return segments
    .map((segment) => `[${formatTime(segment.startMs)} → ${formatTime(segment.endMs)}] ${segment.text}\n`)
    .join('');
}

function formatTime(totalMs: number): string {
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const milliseconds = Math.floor(totalMs % 1_000);
  return `${minutes.toString().padStart(2, '0')}:${seconds
    .toString()
    .padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_JSON_BODY_BYTES) {
    throw new Error('VOIVOX JSON request body is too large.');
  }
  let body = '';
  let bodyBytes = 0;

  for await (const chunk of request) {
    bodyBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (bodyBytes > MAXIMUM_JSON_BODY_BYTES) {
      throw new Error('VOIVOX JSON request body is too large.');
    }
    body += chunk;
  }

  if (!body) {
    throw new Error('A JSON request body is required.');
  }

  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Request body must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
