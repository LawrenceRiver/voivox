import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { VoivoxClient, type VoivoxConnection } from './voivox-client.js';

export function createVoivoxMcpServer(voivox: VoivoxClient): McpServer {
  const server = new McpServer({ name: 'voivox', version: '0.1.0' });

  server.registerTool(
    'voivox_status',
    {
      title: 'VOIVOX status',
      description: 'Read the local VOIVOX desktop app status and its active capture, if any.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    () => toolResult(() => voivox.status())
  );

  server.registerTool(
    'voivox_list_sessions',
    {
      title: 'List VOIVOX sessions',
      description: 'List locally stored VOIVOX transcript sessions, newest first. This reads text metadata only.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    () => toolResult(() => voivox.listSessions())
  );

  server.registerTool(
    'voivox_list_macos_processes',
    {
      title: 'List selectable macOS audio processes',
      description: 'List running macOS apps that can be explicitly selected for muted, local VOIVOX process capture.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    () => toolResult(() => voivox.listMacProcesses())
  );

  server.registerTool(
    'voivox_get_transcript',
    {
      title: 'Get VOIVOX transcript',
      description: 'Read one local VOIVOX session, including immutable timestamped raw text and any derived text-only outputs.',
      inputSchema: { session_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    ({ session_id }) => toolResult(() => voivox.getSession(session_id))
  );

  server.registerTool(
    'voivox_export_transcript',
    {
      title: 'Export raw VOIVOX transcript',
      description: 'Export the immutable raw transcript with timestamps as plain text. This does not call an external AI provider.',
      inputSchema: { session_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ session_id }) => {
      try {
        return { content: [{ type: 'text' as const, text: await voivox.exportRawTranscript(session_id) }] };
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    'voivox_start_capture',
    {
      title: 'Start a VOIVOX capture',
      description: 'Start muted capture for one explicitly selected macOS process in the running VOIVOX desktop app. Chrome tabs must be started from the Chrome extension, which requires a direct user click.',
      inputSchema: {
        source_label: z.string().min(1).max(200),
        process_id: z.number().int().positive()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    ({ source_label, process_id }) =>
      toolResult(() => voivox.startCapture({ kind: 'macos-process', label: source_label, processId: process_id }))
  );

  server.registerTool(
    'voivox_stop_capture',
    {
      title: 'Stop a VOIVOX capture',
      description: 'Stop the specified local VOIVOX capture and preserve the recorded raw transcript locally.',
      inputSchema: { session_id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    ({ session_id }) => toolResult(() => voivox.stopCapture(session_id))
  );

  server.registerTool(
    'voivox_save_derived_text',
    {
      title: 'Save derived VOIVOX text',
      description: 'Store a text-only derivative produced by Codex or an approved text provider. The immutable raw transcript is never changed.',
      inputSchema: {
        session_id: z.string().min(1),
        provider: z.string().min(1).max(100),
        instruction: z.string().min(1).max(2_000),
        text: z.string().max(200_000)
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    ({ session_id, provider, instruction, text }) =>
      toolResult(() => voivox.addDerivedTranscript(session_id, { provider, instruction, text }))
  );

  return server;
}

export async function loadVoivoxConnection(connectionFile = defaultConnectionFile()): Promise<VoivoxConnection> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(connectionFile, 'utf8'));
  } catch {
    throw new Error('VOIVOX desktop app is not ready. Open it once, then try Codex again.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('VOIVOX desktop connection file is invalid. Reopen the app to repair it.');
  }

  const connection = parsed as { baseUrl?: unknown; token?: unknown };
  if (typeof connection.baseUrl !== 'string' || typeof connection.token !== 'string') {
    throw new Error('VOIVOX desktop connection file is invalid. Reopen the app to repair it.');
  }

  return { baseUrl: connection.baseUrl, token: connection.token };
}

export function defaultConnectionFile(): string {
  return process.env.VOIVOX_CONNECTION_FILE ?? join(homedir(), 'Library', 'Application Support', 'VOIVOX', 'mcp-connection.json');
}

async function toolResult(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
      structuredContent: isStructuredRecord(value) ? value : { result: value }
    };
  } catch (error) {
    return toolError(error);
  }
}

function isStructuredRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toolError(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: error instanceof Error ? error.message : 'VOIVOX request failed.'
      }
    ],
    isError: true
  };
}

async function main(): Promise<void> {
  const voivox = new VoivoxClient(await loadVoivoxConnection());
  const server = createVoivoxMcpServer(voivox);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'VOIVOX MCP could not start.');
    process.exitCode = 1;
  });
}
