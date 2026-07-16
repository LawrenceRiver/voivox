import { afterEach, describe, expect, it } from 'vitest';

import { createVoivoxLoopbackServer, type VoivoxLoopbackServer } from '@voivox/core';
import { VoivoxClient } from '../src/voivox-client.js';

describe('VoivoxClient', () => {
  let server: VoivoxLoopbackServer | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it('uses the desktop app token to start and read a local capture', async () => {
    server = await createVoivoxLoopbackServer({ token: 'desktop-only-token' });
    const client = new VoivoxClient({ baseUrl: server.baseUrl, token: 'desktop-only-token' });

    const started = await client.startCapture({ kind: 'microphone', label: 'Internal microphone' });
    const status = await client.status();

    expect(started).toMatchObject({ status: 'capturing' });
    expect(status).toMatchObject({ activeSession: { id: started.id } });
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
});
