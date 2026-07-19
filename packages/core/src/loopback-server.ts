import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  type ActiveVideoTranscriptionOptions,
  type CaptureSession,
  type TranscriptDelta,
  VoivoxService
} from './voivox-service.js';
import {
  CrossWindowSessionStore,
  type CrossWindowSessionInitial,
  type CrossWindowSessionPatch
} from './cross-window-session.js';
import type { TranscriptResult } from './pvtt-contract.js';
import { serializeVoiceVacError } from './voice-vac-error.js';
import { VOICE_VAC_ERROR_CODES } from './voice-vac-error.js';

export const VOIVOX_STORE_EXTENSION_ORIGIN = 'chrome-extension://pepfpbobjbjehhhcjiokmneclohlffno';
export const VOIVOX_AUTOMATION_EXTENSION_ORIGIN = 'chrome-extension://ciijinidnlbokpbeiabifcnoighmbnmh';
export const VOIVOX_EXTENSION_ORIGINS = new Set([
  VOIVOX_STORE_EXTENSION_ORIGIN,
  VOIVOX_AUTOMATION_EXTENSION_ORIGIN
]);
export const VOIVOX_VERSION = '0.1.1';
const NATIVE_PROOF_PATH = '/v1/native/proof';
const NATIVE_PROOF_PROTOCOL_VERSION = 1;
const NATIVE_PROOF_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MCP_PROOF_PATH = '/v1/mcp/proof';
const MCP_PROOF_PROTOCOL_VERSION = 1;
const MCP_PROOF_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const MAXIMUM_JSON_BODY_BYTES = 1_500_000;
const MAXIMUM_PCM_CHUNK_BYTES = 128 * 1024;
const MAXIMUM_TRANSCRIPT_WAIT_MS = 25_000;

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

export type ActiveVideoTranscriptionRequest = ActiveVideoTranscriptionOptions;

export type ExtensionCaptureStartRequest = Readonly<{
  jobId?: string;
  mode: 'fast' | 'quality';
  source: Readonly<{
    kind: 'chrome-tab';
    label: string;
    language?: string;
    title?: string;
    url: string;
  }>;
  tunnelSessionId: string;
}>;

export type ExtensionCaptureControllerPort = {
  getTranscriptRevision(sessionId: string): number;
  hasCapture(sessionId: string): boolean;
  ingestAudio(sessionId: string, sequence: number, pcm: Uint8Array): void;
  startCapture(request: ExtensionCaptureStartRequest): CaptureSession;
  stopCapture(sessionId: string): Promise<CaptureSession>;
  waitForTranscript(
    sessionId: string,
    afterRevision: number,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<TranscriptDelta | undefined>;
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
  onActiveVideoTranscription?: (
    request: ActiveVideoTranscriptionRequest
  ) => Promise<TranscriptResult | undefined>;
  extensionCaptureController?: ExtensionCaptureControllerPort;
  tunnelSessions?: CrossWindowSessionStore;
}): Promise<VoivoxLoopbackServer> {
  const service = options.service ?? new VoivoxService();
  const tunnelSessions = options.tunnelSessions ?? new CrossWindowSessionStore();
  let actualBaseUrl: string | undefined;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        const origin = request.headers.origin;
        if (origin && VOIVOX_EXTENSION_ORIGINS.has(origin)) {
          applyExtensionCors(response, origin);
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
          sendJson(response, 405, { error: 'Voice Vac MCP proof requires GET.' });
          return;
        }
        const challenge = parseMcpProofChallenge(requestUrl);
        if (!challenge) {
          sendJson(response, 400, { error: 'A valid Voice Vac MCP proof challenge is required.' });
          return;
        }
        if (!actualBaseUrl) {
          sendJson(response, 503, { error: 'Voice Vac MCP proof is unavailable.' });
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
          sendJson(response, 405, { error: 'Voice Vac native proof requires GET.' });
          return;
        }
        const challenge = parseNativeProofChallenge(requestUrl);
        if (!challenge) {
          sendJson(response, 400, { error: 'A valid Voice Vac native proof challenge is required.' });
          return;
        }
        if (!options.extensionToken || !actualBaseUrl) {
          sendJson(response, 503, { error: 'Voice Vac native proof is unavailable.' });
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
        const origin = request.headers.origin;
        if (!origin || !VOIVOX_EXTENSION_ORIGINS.has(origin)) {
          sendJson(response, 403, { error: 'This Voice Vac extension origin is not allowed.' });
          return;
        }
        applyExtensionCors(response, origin);

        if (request.method === 'OPTIONS') {
          response.writeHead(204);
          response.end();
          return;
        }

        if (!options.extensionToken || !isAuthorized(request, options.extensionToken)) {
          sendJson(response, 401, { error: 'Voice Vac Chrome bridge token required.' });
          return;
        }

        const extensionCaptureResponse = await handleExtensionCaptureRequest(
          request,
          response,
          requestUrl,
          options.extensionCaptureController
        );
        if (extensionCaptureResponse) return;

        const extensionTunnelResponse = await handleTunnelSessionRequest(request, response, tunnelSessions, true);
        if (extensionTunnelResponse) return;

        sendJson(response, 404, { error: 'Unknown Voice Vac Chrome bridge endpoint.' });
        return;
      }

      if (!isAuthorized(request, options.token)) {
        sendJson(response, 401, { error: 'Local Voice Vac bearer token required.' });
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/status') {
        sendJson(response, 200, {
          activeSession: service.getActiveSession(),
          sessionCount: service.listSessions().length
        });
        return;
      }

      const tunnelResponse = await handleTunnelSessionRequest(request, response, tunnelSessions, false);
      if (tunnelResponse) return;

      if (request.method === 'POST' && request.url === '/v1/transcriptions/active-video') {
        const body = await readJson(request);
        if (!isActiveVideoTranscriptionRequest(body)) {
          sendJson(response, 400, { error: 'A valid Voice Vac active-video transcription request is required.' });
          return;
        }
        const result = await (options.onActiveVideoTranscription?.(body)
          ?? Promise.resolve(service.getLatestBrowserTranscript()));
        if (!result) {
          sendJson(response, 409, {
            code: 'PVTT_NO_ACTIVE_VIDEO',
            error: 'No completed browser video is registered. Start Voice Vac on the target tab, then try again.'
          });
          return;
        }
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/transcripts/latest') {
        const result = service.getLatestBrowserTranscript();
        if (!result) {
          sendJson(response, 404, { code: 'PVTT_NO_TRANSCRIPT', error: 'No browser transcript is available yet.' });
          return;
        }
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/sessions') {
        sendJson(response, 200, { sessions: service.listSessions() });
        return;
      }

      if (request.method === 'GET' && request.url === '/v1/macos-processes') {
        if (!options.listMacProcesses) {
          sendJson(response, 503, { error: 'Voice Vac macOS process capture is not available in this desktop app.' });
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
          sendJson(response, 404, { error: 'Voice Vac session not found.' });
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
          sendJson(response, 404, { error: 'Voice Vac session not found.' });
          return;
        }

        sendJson(response, 200, session);
        return;
      }

      sendJson(response, 404, { error: 'Unknown Voice Vac endpoint.' });
    } catch (error) {
      if (error instanceof RequestBodyError) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const serialized = serializeVoiceVacError(error);
      sendJson(response, serialized.statusCode, serialized.body);
    }
  });

  await listen(server, options.port ?? 0);
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Voice Vac loopback server did not expose a TCP address.');
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

function applyExtensionCors(response: ServerResponse, origin: string): void {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  response.setHeader('access-control-allow-headers', 'authorization, content-type');
  response.setHeader('vary', 'Origin');
}

async function handleExtensionCaptureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL | undefined,
  controller: ExtensionCaptureControllerPort | undefined
): Promise<boolean> {
  const prefix = '/v1/extension/captures';
  if (!requestUrl?.pathname.startsWith(prefix) || !controller) return false;

  if (request.method === 'POST' && requestUrl.pathname === prefix && requestUrl.search === '') {
    const body = await readJson(request);
    if (!isExtensionCaptureStartRequest(body)) {
      sendJson(response, 400, {
        error: 'Voice VAC extension capture requires one armed Chrome tab and tunnel session.'
      });
      return true;
    }
    sendJson(response, 201, controller.startCapture(body));
    return true;
  }

  const audioMatch = requestUrl.pathname.match(
    /^\/v1\/extension\/captures\/([^/]+)\/audio\/(0|[1-9]\d*)$/u
  );
  if (request.method === 'POST' && audioMatch && requestUrl.search === '') {
    const sessionId = decodeURIComponent(audioMatch[1]!);
    if (!controller.hasCapture(sessionId)) {
      sendJson(response, 404, { error: 'Voice VAC extension capture was not found.' });
      return true;
    }
    const sequence = Number(audioMatch[2]);
    if (!Number.isSafeInteger(sequence)) {
      sendJson(response, 400, { error: 'Voice VAC audio sequence must be a nonnegative integer.' });
      return true;
    }
    const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/octet-stream') {
      sendJson(response, 400, { error: 'Voice VAC extension audio requires application/octet-stream.' });
      return true;
    }
    const pcm = await readPcm16(request);
    controller.ingestAudio(sessionId, sequence, pcm);
    response.writeHead(204);
    response.end();
    return true;
  }

  const transcriptMatch = requestUrl.pathname.match(
    /^\/v1\/extension\/captures\/([^/]+)\/transcript$/u
  );
  if (request.method === 'GET' && transcriptMatch) {
    const sessionId = decodeURIComponent(transcriptMatch[1]!);
    if (!controller.hasCapture(sessionId)) {
      sendJson(response, 404, { error: 'Voice VAC extension capture was not found.' });
      return true;
    }
    const query = parseExtensionTranscriptQuery(requestUrl);
    if (!query) {
      sendJson(response, 400, {
        error: 'Voice VAC transcript polling requires after_revision and an optional wait_ms up to 25000.'
      });
      return true;
    }
    const currentRevision = controller.getTranscriptRevision(sessionId);
    if (query.afterRevision > currentRevision) {
      sendJson(response, 400, {
        error: `Voice VAC transcript cursor cannot be newer than revision ${currentRevision}.`
      });
      return true;
    }

    const abortController = new AbortController();
    const abortWait = () => abortController.abort();
    request.once('aborted', abortWait);
    response.once('close', abortWait);
    if (request.aborted || response.destroyed) abortWait();
    let delta: TranscriptDelta | undefined;
    try {
      delta = await controller.waitForTranscript(
        sessionId,
        query.afterRevision,
        query.waitMs,
        abortController.signal
      );
    } catch (error) {
      if (abortController.signal.aborted && isAbortError(error)) return true;
      throw error;
    } finally {
      request.off('aborted', abortWait);
      response.off('close', abortWait);
    }
    if (abortController.signal.aborted) return true;
    if (!delta) {
      response.writeHead(204);
      response.end();
      return true;
    }
    sendJson(response, 200, delta);
    return true;
  }

  const stopMatch = requestUrl.pathname.match(
    /^\/v1\/extension\/captures\/([^/]+)\/stop$/u
  );
  if (request.method === 'POST' && stopMatch && requestUrl.search === '') {
    const sessionId = decodeURIComponent(stopMatch[1]!);
    if (!controller.hasCapture(sessionId)) {
      sendJson(response, 404, { error: 'Voice VAC extension capture was not found.' });
      return true;
    }
    sendJson(response, 200, await controller.stopCapture(sessionId));
    return true;
  }

  sendJson(response, 404, { error: 'Unknown Voice VAC extension capture endpoint.' });
  return true;
}

function parseExtensionTranscriptQuery(url: URL): {
  afterRevision: number;
  waitMs: number;
} | undefined {
  const entries = [...url.searchParams.entries()];
  if (
    entries.length < 1
    || entries.length > 2
    || entries.some(([key]) => key !== 'after_revision' && key !== 'wait_ms')
    || url.searchParams.getAll('after_revision').length !== 1
    || url.searchParams.getAll('wait_ms').length > 1
  ) {
    return undefined;
  }
  const afterRevision = parseCanonicalInteger(url.searchParams.get('after_revision'));
  const waitValue = url.searchParams.get('wait_ms');
  const waitMs = waitValue === null
    ? MAXIMUM_TRANSCRIPT_WAIT_MS
    : parseCanonicalInteger(waitValue);
  if (
    afterRevision === undefined
    || waitMs === undefined
    || waitMs < 1
    || waitMs > MAXIMUM_TRANSCRIPT_WAIT_MS
  ) {
    return undefined;
  }
  return { afterRevision, waitMs };
}

function parseCanonicalInteger(value: string | null): number | undefined {
  if (value === null || !/^(0|[1-9]\d*)$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function handleTunnelSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: CrossWindowSessionStore,
  extension: boolean
): Promise<boolean> {
  const prefix = extension ? '/v1/extension/tunnel-sessions' : '/v1/tunnel-sessions';
  if (!request.url?.startsWith(prefix)) return false;
  const detailMatch = request.url.match(new RegExp(`^${prefix.replaceAll('/', '\\/')}\\/([^/]+)$`));
  if (request.url === prefix && request.method === 'GET') {
    sendJson(response, 200, { sessions: store.list() });
    return true;
  }
  if (request.url === prefix && request.method === 'POST') {
    const body = await readJson(request);
    if (!isTunnelCreateRequest(body)) {
      sendJson(response, 400, { error: 'A valid browser tab id is required to create a tunnel session.' });
      return true;
    }
    const { tabId, ...initial } = body;
    sendJson(response, 201, store.create(tabId, initial));
    return true;
  }
  if (!detailMatch) {
    response.setHeader('allow', 'GET, POST, PATCH, DELETE');
    sendJson(response, 405, { error: 'Voice Vac tunnel session method is not supported.' });
    return true;
  }
  const id = decodeURIComponent(detailMatch[1]!);
  if (request.method === 'GET') {
    const session = store.get(id);
    if (!session) {
      sendJson(response, 404, { error: 'Voice Vac tunnel session not found.' });
      return true;
    }
    sendJson(response, 200, session);
    return true;
  }
  if (request.method === 'PATCH') {
    const body = await readJson(request);
    if (!isTunnelPatch(body)) {
      sendJson(response, 400, { error: 'Invalid Voice Vac tunnel session patch.' });
      return true;
    }
    try {
      sendJson(response, 200, store.update(id, body));
    } catch (error) {
      sendJson(response, 404, { error: error instanceof Error ? error.message : 'Voice Vac tunnel session not found.' });
    }
    return true;
  }
  if (request.method === 'DELETE') {
    store.close(id);
    response.writeHead(204);
    response.end();
    return true;
  }
  response.setHeader('allow', 'GET, PATCH, DELETE');
  sendJson(response, 405, { error: 'Voice Vac tunnel session method is not supported.' });
  return true;
}

function isTunnelCreateRequest(value: Record<string, unknown>): value is { tabId: number } & CrossWindowSessionInitial {
  const tabId = value.tabId;
  return hasOnlyTunnelKeys(value, new Set([
    'tabId', 'frameId', 'documentId', 'dropToken',
    'state', 'errorCode', 'title', 'url', 'appEndpoint', 'pageEndpoint', 'targetRect'
  ]))
    && typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0
    && typeof value.frameId === 'number' && Number.isSafeInteger(value.frameId) && value.frameId >= 0
    && typeof value.documentId === 'string' && value.documentId.length > 0 && value.documentId.trim() === value.documentId
    && typeof value.dropToken === 'string'
    && /^VOICE_VAC_DROP_V1\|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\|[A-Za-z0-9_-]{43}$/iu.test(value.dropToken)
    && isCanonicalHttpUrl(value.url)
    && hasValidTunnelMutableFields(value);
}

function isTunnelPatch(value: Record<string, unknown>): value is CrossWindowSessionPatch {
  return hasOnlyTunnelKeys(value, new Set([
    'state', 'errorCode', 'title', 'url', 'appEndpoint', 'pageEndpoint', 'targetRect'
  ])) && hasValidTunnelMutableFields(value);
}

function hasValidTunnelMutableFields(value: Record<string, unknown>): boolean {
  if (value.state !== undefined && !['idle', 'dragging', 'detecting', 'ready', 'transcribing', 'paused', 'completed', 'error'].includes(String(value.state))) return false;
  if (value.errorCode !== undefined && !VOICE_VAC_ERROR_CODES.includes(value.errorCode as never)) return false;
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 500)) return false;
  if (value.url !== undefined && !isCanonicalHttpUrl(value.url)) return false;
  if (value.appEndpoint !== undefined && !isTunnelPoint(value.appEndpoint)) return false;
  if (value.pageEndpoint !== undefined && !isTunnelPoint(value.pageEndpoint)) return false;
  if (value.targetRect !== undefined && !isTunnelRect(value.targetRect)) return false;
  return true;
}

function hasOnlyTunnelKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isTunnelPoint(value: unknown): value is { screenX: number; screenY: number } {
  if (!value || typeof value !== 'object') return false;
  const point = value as { screenX?: unknown; screenY?: unknown };
  return typeof point.screenX === 'number' && Number.isFinite(point.screenX)
    && typeof point.screenY === 'number' && Number.isFinite(point.screenY);
}

function isTunnelRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object') return false;
  const rect = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  return typeof rect.x === 'number' && Number.isFinite(rect.x)
    && typeof rect.y === 'number' && Number.isFinite(rect.y)
    && typeof rect.width === 'number' && Number.isFinite(rect.width) && rect.width >= 0
    && typeof rect.height === 'number' && Number.isFinite(rect.height) && rect.height >= 0;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

function isExtensionCaptureStartRequest(
  value: Record<string, unknown>
): value is ExtensionCaptureStartRequest {
  if (!hasOnlyKeys(value, new Set(['jobId', 'mode', 'source', 'tunnelSessionId']))) {
    return false;
  }
  if (!value.source || typeof value.source !== 'object' || Array.isArray(value.source)) {
    return false;
  }
  const source = value.source as Record<string, unknown>;
  return hasOnlyKeys(source, new Set(['kind', 'label', 'language', 'title', 'url']))
    && source.kind === 'chrome-tab'
    && isBoundedNonemptyString(source.label, 500)
    && (source.language === undefined || isBoundedNonemptyString(source.language, 40))
    && (source.title === undefined || isBoundedString(source.title, 500))
    && isCanonicalHttpUrl(source.url)
    && (value.mode === 'fast' || value.mode === 'quality')
    && isBoundedNonemptyString(value.tunnelSessionId, 500)
    && (value.jobId === undefined || isBoundedNonemptyString(value.jobId, 500));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedNonemptyString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && value.trim() === value;
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length <= maximumLength;
}

function isCanonicalHttpUrl(value: unknown): value is string {
  if (!isBoundedNonemptyString(value, 4_000)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isCaptureSource(value: unknown): value is {
  kind: 'chrome-tab' | 'macos-process' | 'microphone';
  label: string;
  processId?: number;
  title?: string;
  url?: string;
  language?: string;
} {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const source = value as {
    kind?: unknown;
    label?: unknown;
    processId?: unknown;
    title?: unknown;
    url?: unknown;
    language?: unknown;
  };
  return (
    (source.kind === 'chrome-tab' || source.kind === 'macos-process' || source.kind === 'microphone') &&
    typeof source.label === 'string' &&
    source.label.length > 0 &&
    (source.processId === undefined || (typeof source.processId === 'number' && Number.isInteger(source.processId) && source.processId > 0)) &&
    (source.title === undefined || (typeof source.title === 'string' && source.title.length <= 500)) &&
    (source.url === undefined || (typeof source.url === 'string' && source.url.length <= 4_000)) &&
    (source.language === undefined || (typeof source.language === 'string' && source.language.length <= 40))
  );
}

function isActiveVideoTranscriptionRequest(value: unknown): value is ActiveVideoTranscriptionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return (
    (request.mode === 'auto' || request.mode === 'live' || request.mode === 'accelerated')
    && typeof request.language === 'string'
    && request.language.length > 0
    && typeof request.timestamps === 'boolean'
    && (request.output_format === 'text'
      || request.output_format === 'json'
      || request.output_format === 'srt'
      || request.output_format === 'vtt')
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
    throw new RequestBodyError('Voice Vac JSON request body is too large.');
  }
  let body = '';
  let bodyBytes = 0;

  for await (const chunk of request) {
    bodyBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (bodyBytes > MAXIMUM_JSON_BODY_BYTES) {
      throw new RequestBodyError('Voice Vac JSON request body is too large.');
    }
    body += chunk;
  }

  if (!body) {
    throw new RequestBodyError('A JSON request body is required.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RequestBodyError('Request body must contain valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestBodyError('Request body must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

async function readPcm16(request: IncomingMessage): Promise<Uint8Array> {
  const declaredLength = Number(request.headers['content-length']);
  if (
    Number.isFinite(declaredLength)
    && (declaredLength <= 0 || declaredLength > MAXIMUM_PCM_CHUNK_BYTES)
  ) {
    throw new RequestBodyError('Voice VAC PCM16 request body must be between 1 byte and 128 KiB.');
  }
  const chunks: Uint8Array[] = [];
  let bodyBytes = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk);
    bodyBytes += bytes.byteLength;
    if (bodyBytes > MAXIMUM_PCM_CHUNK_BYTES) {
      throw new RequestBodyError('Voice VAC PCM16 request body must not exceed 128 KiB.');
    }
    chunks.push(bytes);
  }
  if (bodyBytes === 0 || bodyBytes % 2 !== 0) {
    throw new RequestBodyError('Voice VAC PCM16 request body must contain complete signed 16-bit samples.');
  }
  const pcm = new Uint8Array(bodyBytes);
  let offset = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return pcm;
}

class RequestBodyError extends Error {}

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
