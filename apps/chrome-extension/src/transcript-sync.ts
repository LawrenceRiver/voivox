import type { BridgeConfig } from './bridge.js';

export type BrowserTranscriptSync = {
  bridge?: BridgeConfig;
  durationSeconds: number;
  tabTitle: string;
  transcript: string;
};

export async function syncBrowserTranscriptToDesktop(
  input: BrowserTranscriptSync,
  request: typeof fetch = fetch
): Promise<boolean> {
  const transcript = input.transcript.trim();
  if (!input.bridge || !transcript) {
    return false;
  }

  const durationMs = Math.min(
    600_000,
    Math.max(0, Math.round(input.durationSeconds * 1_000))
  );
  try {
    const response = await request(`${input.bridge.baseUrl}/v1/extension/transcripts`, {
      body: JSON.stringify({
        durationMs,
        source: { kind: 'chrome-tab', label: input.tabTitle.slice(0, 200) },
        transcript
      }),
      headers: {
        authorization: `Bearer ${input.bridge.token}`,
        'content-type': 'application/json'
      },
      method: 'POST'
    });
    return response.ok;
  } catch {
    return false;
  }
}
