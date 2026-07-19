import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  ActiveVideoTranscriptionOptions,
  CaptureSession,
  CaptureSource,
  DerivedTranscript,
  MacAudioProcess,
  TranscriptResult
} from '@voivox/core';

export type VoivoxConnection = {
  baseUrl: string;
  token: string;
};

export type VoivoxClientOptions = {
  captureStopTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export class VoivoxRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'VoivoxRequestError';
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CAPTURE_STOP_TIMEOUT_MS = 30 * 60_000;
const MCP_PROOF_PROTOCOL_VERSION = 1;
const MAXIMUM_PROOF_RESPONSE_BYTES = 4_096;
const ENCODED_SHA256 = /^[A-Za-z0-9_-]{43}$/;
const INVALID_SERVER_PROOF_MESSAGE = 'Voice Vac desktop app identity proof is invalid. Reopen the app, then try again.';

export class VoivoxClient {
  private readonly baseUrl: string;
  private readonly captureStopTimeoutMs: number;
  private proofInFlight: Promise<void> | undefined;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly connection: VoivoxConnection,
    options: VoivoxClientOptions = {}
  ) {
    this.baseUrl = connection.baseUrl.replace(/\/$/, '');
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.captureStopTimeoutMs = options.captureStopTimeoutMs ?? DEFAULT_CAPTURE_STOP_TIMEOUT_MS;
    if (!isPositiveTimeout(this.requestTimeoutMs) || !isPositiveTimeout(this.captureStopTimeoutMs)) {
      throw new Error('Voice Vac request timeouts must be positive numbers.');
    }
  }

  async status(): Promise<{ activeSession?: CaptureSession; sessionCount: number }> {
    return this.requestJson('/v1/status');
  }

  async transcribeActiveVideo(options: ActiveVideoTranscriptionOptions): Promise<TranscriptResult> {
    return this.requestJson('/v1/transcriptions/active-video', {
      body: JSON.stringify(options),
      method: 'POST'
    });
  }

  async getLatestTranscript(): Promise<TranscriptResult> {
    return this.requestJson('/v1/transcripts/latest');
  }

  async startCapture(source: CaptureSource): Promise<CaptureSession> {
    return this.requestJson('/v1/captures', {
      body: JSON.stringify({ source }),
      method: 'POST'
    });
  }

  async stopCapture(sessionId: string): Promise<CaptureSession> {
    return this.requestJson(
      `/v1/captures/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST' },
      this.captureStopTimeoutMs
    );
  }

  async listSessions(): Promise<CaptureSession[]> {
    const response = await this.requestJson<{ sessions: CaptureSession[] }>('/v1/sessions');
    return response.sessions;
  }

  async listMacProcesses(): Promise<MacAudioProcess[]> {
    const response = await this.requestJson<{ processes: MacAudioProcess[] }>('/v1/macos-processes');
    return response.processes;
  }

  async getSession(sessionId: string): Promise<CaptureSession> {
    return this.requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async exportRawTranscript(sessionId: string): Promise<string> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/export`,
      {},
      (response) => response.text()
    );
  }

  async addDerivedTranscript(
    sessionId: string,
    transcript: DerivedTranscript
  ): Promise<CaptureSession> {
    return this.requestJson(`/v1/sessions/${encodeURIComponent(sessionId)}/derived`, {
      body: JSON.stringify(transcript),
      method: 'POST'
    });
  }

  private async requestJson<T>(
    path: string,
    options: RequestInit = {},
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    return this.request(path, options, (response) => response.json() as Promise<T>, timeoutMs);
  }

  private async request<T>(
    path: string,
    options: RequestInit,
    read: (response: Response) => Promise<T>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    await this.verifyServerIdentity();
    const headers = new Headers(options.headers);
    headers.set('authorization', `Bearer ${this.connection.token}`);
    if (options.body) {
      headers.set('content-type', 'application/json');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    let receivedResponse = false;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers,
        signal: controller.signal
      });
      receivedResponse = true;

      if (!response.ok) {
        const error = await response.json().catch(() => ({} as { error?: string; code?: string }));
        const message = typeof error.error === 'string' ? error.error : `Voice Vac returned ${response.status}.`;
        throw new VoivoxRequestError(message, typeof error.code === 'string' ? error.code : undefined, response.status);
      }

      return await read(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Voice Vac desktop app did not respond within ${timeoutMs} ms.`);
      }
      if (!receivedResponse) {
        throw new Error('Voice Vac desktop app is not reachable. Open the app, then try again.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private verifyServerIdentity(): Promise<void> {
    if (!this.proofInFlight) {
      const proof = this.requestServerProof();
      this.proofInFlight = proof;
      void proof.then(
        () => {
          if (this.proofInFlight === proof) {
            this.proofInFlight = undefined;
          }
        },
        () => {
          if (this.proofInFlight === proof) {
            this.proofInFlight = undefined;
          }
        }
      );
    }
    return this.proofInFlight;
  }

  private async requestServerProof(): Promise<void> {
    const challenge = randomBytes(32).toString('base64url');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref();
    let receivedResponse = false;
    try {
      const response = await fetch(
        `${this.baseUrl}/v1/mcp/proof?challenge=${encodeURIComponent(challenge)}`,
        {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: controller.signal
        }
      );
      receivedResponse = true;
      if (!response.ok || response.headers.get('cache-control') !== 'no-store') {
        throw invalidServerProof();
      }
      const raw = await readBoundedProofBody(response, controller);
      const body = JSON.parse(raw) as unknown;
      if (!isStrictProofResponse(body, this.baseUrl)) {
        throw invalidServerProof();
      }

      const receivedProof = Buffer.from(body.proof, 'base64url');
      const expectedProof = createHmac('sha256', this.connection.token)
        .update(mcpProofMessage(challenge, this.baseUrl))
        .digest();
      if (
        receivedProof.length !== expectedProof.length
        || !timingSafeEqual(receivedProof, expectedProof)
      ) {
        throw invalidServerProof();
      }
    } catch (error) {
      if (error instanceof InvalidServerProofError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new Error(`Voice Vac desktop app did not respond within ${this.requestTimeoutMs} ms.`);
      }
      if (!receivedResponse) {
        throw new Error('Voice Vac desktop app is not reachable. Open the app, then try again.');
      }
      throw invalidServerProof();
    } finally {
      clearTimeout(timeout);
    }
  }
}

type McpProofResponse = {
  baseUrl: string;
  proof: string;
  protocolVersion: 1;
  service: 'voivox';
  status: 'ready';
};

class InvalidServerProofError extends Error {
  constructor() {
    super(INVALID_SERVER_PROOF_MESSAGE);
    this.name = 'InvalidServerProofError';
  }
}

async function readBoundedProofBody(
  response: Response,
  controller: AbortController
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes)
      || declaredBytes < 0
      || declaredBytes > MAXIMUM_PROOF_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      controller.abort();
      throw invalidServerProof();
    }
  }
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let receivedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > MAXIMUM_PROOF_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        controller.abort();
        throw invalidServerProof();
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function isStrictProofResponse(value: unknown, baseUrl: string): value is McpProofResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const response = value as Record<string, unknown>;
  const keys = Object.keys(response).sort();
  return (
    keys.length === 5
    && keys[0] === 'baseUrl'
    && keys[1] === 'proof'
    && keys[2] === 'protocolVersion'
    && keys[3] === 'service'
    && keys[4] === 'status'
    && response.baseUrl === baseUrl
    && typeof response.proof === 'string'
    && ENCODED_SHA256.test(response.proof)
    && response.protocolVersion === MCP_PROOF_PROTOCOL_VERSION
    && response.service === 'voivox'
    && response.status === 'ready'
  );
}

function mcpProofMessage(challenge: string, baseUrl: string): string {
  return `voivox-mcp-proof\n${MCP_PROOF_PROTOCOL_VERSION}\n${challenge}\n${baseUrl}`;
}

function invalidServerProof(): Error {
  return new InvalidServerProofError();
}

function isPositiveTimeout(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
