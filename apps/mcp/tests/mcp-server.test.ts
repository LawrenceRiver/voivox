import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createVoivoxLoopbackServer, type VoivoxLoopbackServer } from '@voivox/core';
import { createVoivoxMcpServer } from '../src/index.js';
import { VoivoxClient } from '../src/voivox-client.js';

describe('VOIVOX MCP wrapper', () => {
  let loopback: VoivoxLoopbackServer | undefined;
  let mcpClient: Client | undefined;

  afterEach(async () => {
    await mcpClient?.close();
    await loopback?.close();
  });

  it('exposes status as a read-only Codex tool', async () => {
    loopback = await createVoivoxLoopbackServer({
      token: 'desktop-only-token',
      listMacProcesses: async () => [{ bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 }]
    });
    const voivox = new VoivoxClient({ baseUrl: loopback.baseUrl, token: 'desktop-only-token' });
    const server = createVoivoxMcpServer(voivox);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcpClient = new Client({ name: 'voivox-test-client', version: '1.0.0' });

    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const tools = await mcpClient.listTools();
    const statusTool = tools.tools.find((tool) => tool.name === 'voivox_status');
    expect(statusTool?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.tools.find((tool) => tool.name === 'voivox_list_macos_processes')?.annotations).toMatchObject({ readOnlyHint: true });

    const result = await mcpClient.callTool({ name: 'voivox_status', arguments: {} });
    expect(result.content).toContainEqual({
      type: 'text',
      text: expect.stringContaining('"sessionCount": 0')
    });

    const processes = await mcpClient.callTool({ name: 'voivox_list_macos_processes', arguments: {} });
    expect(processes.structuredContent).toEqual({
      result: [{ bundleId: 'com.apple.Safari', name: 'Safari', pid: 42 }]
    });
  });
});
