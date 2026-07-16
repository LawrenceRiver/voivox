import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { type CaptureSession, VoivoxService } from './voivox-service.js';

export type VoivoxLoopbackServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

export type ChromeAudioChunk = {
  sessionId: string;
  pcm: Uint8Array;
  sampleRate: 16_000;
  channels: 1;
};

export type MacAudioProcess = {
  bundleId: string;
  name: string;
  pid: number;
};

export async function createVoivoxLoopbackServer(options: {
  token: string;
  service?: VoivoxService;
  extensionToken?: string;
  listMacProcesses?: () => Promise<MacAudioProcess[]>;
  onAudioChunk?: (chunk: ChromeAudioChunk) => void | Promise<void>;
  onCaptureStarted?: (session: CaptureSession) => void | Promise<void>;
  onCaptureStopping?: (sessionId: string) => void | Promise<void>;
}): Promise<VoivoxLoopbackServer> {
  const service = options.service ?? new VoivoxService();
  const chromeSessionIds = new Set<string>();
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        sendJson(response, 200, { service: 'voivox', status: 'ready' });
        return;
      }

      if (request.url?.startsWith('/v1/extension/')) {
        if (!options.extensionToken || !isAuthorized(request, options.extensionToken)) {
          sendJson(response, 401, { error: 'VOIVOX Chrome bridge token required.' });
          return;
        }

        if (request.method === 'POST' && request.url === '/v1/extension/captures') {
          const body = await readJson(request);
          const source = body.source;
          if (!isCaptureSource(source) || source.kind !== 'chrome-tab') {
            sendJson(response, 400, { error: 'Chrome bridge can only capture the explicitly selected Chrome tab.' });
            return;
          }

          const session = service.startCapture(source);
          chromeSessionIds.add(session.id);
          sendJson(response, 201, session);
          return;
        }

        const audioMatch = request.url.match(/^\/v1\/extension\/captures\/([^/]+)\/audio$/);
        if (request.method === 'POST' && audioMatch) {
          const sessionId = decodeURIComponent(audioMatch[1]!);
          if (!chromeSessionIds.has(sessionId)) {
            sendJson(response, 404, { error: 'VOIVOX Chrome capture was not found.' });
            return;
          }
          const body = await readJson(request);
          if (!isChromeAudioBody(body)) {
            sendJson(response, 400, { error: 'Chrome bridge requires 16 kHz mono pcm-s16le audio.' });
            return;
          }

          const pcm = Buffer.from(body.data, 'base64');
          if (pcm.length === 0) {
            sendJson(response, 400, { error: 'Chrome bridge audio chunk was empty.' });
            return;
          }
          await options.onAudioChunk?.({
            sessionId,
            pcm: new Uint8Array(pcm),
            sampleRate: 16_000,
            channels: 1
          });
          response.writeHead(204);
          response.end();
          return;
        }

        const extensionStopMatch = request.url.match(/^\/v1\/extension\/captures\/([^/]+)\/stop$/);
        if (request.method === 'POST' && extensionStopMatch) {
          const sessionId = decodeURIComponent(extensionStopMatch[1]!);
          if (!chromeSessionIds.has(sessionId)) {
            sendJson(response, 404, { error: 'VOIVOX Chrome capture was not found.' });
            return;
          }
          await options.onCaptureStopping?.(sessionId);
          const session = service.stopCapture(sessionId);
          chromeSessionIds.delete(sessionId);
          sendJson(response, 200, session);
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
        chromeSessionIds.delete(sessionId);
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

  await listen(server);
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('VOIVOX loopback server did not expose a TCP address.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => close(server)
  };
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

function isChromeAudioBody(value: unknown): value is {
  encoding: 'pcm-s16le';
  sampleRate: 16_000;
  channels: 1;
  data: string;
} {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const audio = value as { encoding?: unknown; sampleRate?: unknown; channels?: unknown; data?: unknown };
  return (
    audio.encoding === 'pcm-s16le' &&
    audio.sampleRate === 16_000 &&
    audio.channels === 1 &&
    typeof audio.data === 'string' &&
    audio.data.length > 0 &&
    audio.data.length <= 1_000_000
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
  let body = '';

  for await (const chunk of request) {
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

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
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
