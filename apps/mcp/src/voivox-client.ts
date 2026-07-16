import type { CaptureSession, CaptureSource, DerivedTranscript, MacAudioProcess } from '@voivox/core';

export type VoivoxConnection = {
  baseUrl: string;
  token: string;
};

export class VoivoxClient {
  private readonly baseUrl: string;

  constructor(private readonly connection: VoivoxConnection) {
    this.baseUrl = connection.baseUrl.replace(/\/$/, '');
  }

  async status(): Promise<{ activeSession?: CaptureSession; sessionCount: number }> {
    return this.requestJson('/v1/status');
  }

  async startCapture(source: CaptureSource): Promise<CaptureSession> {
    return this.requestJson('/v1/captures', {
      body: JSON.stringify({ source }),
      method: 'POST'
    });
  }

  async stopCapture(sessionId: string): Promise<CaptureSession> {
    return this.requestJson(`/v1/captures/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' });
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
    const response = await this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/export`);
    return response.text();
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

  private async requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await this.request(path, options);
    return response.json() as Promise<T>;
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set('authorization', `Bearer ${this.connection.token}`);
    if (options.body) {
      headers.set('content-type', 'application/json');
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...options, headers });
    } catch {
      throw new Error('VOIVOX desktop app is not reachable. Open the app, then try again.');
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({} as { error?: string }));
      const message = typeof error.error === 'string' ? error.error : `VOIVOX returned ${response.status}.`;
      throw new Error(message);
    }

    return response;
  }
}
