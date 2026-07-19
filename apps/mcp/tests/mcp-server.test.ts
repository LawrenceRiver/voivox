import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createVoivoxLoopbackServer, VoivoxService, type VoivoxLoopbackServer } from '@voivox/core';
import { createVoivoxMcpServer } from '../src/index.js';
import { VoivoxClient } from '../src/voivox-client.js';

describe('Voice Vac MCP wrapper', () => {
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

  it('returns the active browser video as a structured transcript result', async () => {
    const service = new VoivoxService();
    service.importCompletedCapture(
      {
        kind: 'chrome-tab',
        label: '我的无字幕视频',
        language: 'zh',
        title: '我的视频标题',
        url: 'https://example.com/video/123'
      },
      [{ startMs: 0, endMs: 2_400, text: '这是视频里的第一段话。' }]
    );
    loopback = await createVoivoxLoopbackServer({ token: 'desktop-only-token', service });
    const voivox = new VoivoxClient({ baseUrl: loopback.baseUrl, token: 'desktop-only-token' });
    const server = createVoivoxMcpServer(voivox);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcpClient = new Client({ name: 'voivox-test-client', version: '1.0.0' });

    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const tools = await mcpClient.listTools();
    expect(tools.tools.find((tool) => tool.name === 'transcribe_active_video')).toBeTruthy();

    const result = await mcpClient.callTool({
      name: 'transcribe_active_video',
      arguments: { mode: 'auto', language: 'auto', timestamps: false, output_format: 'text' }
    });

    expect(result.structuredContent).toMatchObject({
      status: 'completed',
      source_url: 'https://example.com/video/123',
      title: '我的视频标题',
      language: 'zh',
      processing_mode: 'live_tunnel',
      transcript: '这是视频里的第一段话。',
      segments: [{ start: 0, end: 2.4, text: '这是视频里的第一段话。' }]
    });

    const latest = await mcpClient.callTool({ name: 'get_latest_transcript', arguments: {} });
    expect(latest.structuredContent).toMatchObject({
      title: '我的视频标题',
      transcript: '这是视频里的第一段话。'
    });
  });

  it('returns a stable error code when no active browser video exists', async () => {
    loopback = await createVoivoxLoopbackServer({ token: 'desktop-only-token' });
    const voivox = new VoivoxClient({ baseUrl: loopback.baseUrl, token: 'desktop-only-token' });
    const server = createVoivoxMcpServer(voivox);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    mcpClient = new Client({ name: 'voivox-test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const result = await mcpClient.callTool({
      name: 'transcribe_active_video',
      arguments: { mode: 'auto', language: 'auto', timestamps: false, output_format: 'text' }
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: 'PVTT_NO_ACTIVE_VIDEO',
        message: expect.stringContaining('No completed browser video')
      }
    });
  });
});
