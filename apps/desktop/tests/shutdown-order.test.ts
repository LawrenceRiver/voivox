import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('desktop shutdown', () => {
  it('runs every cleanup step in order when earlier steps reject', async () => {
    const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
    const calls: string[] = [];
    const shutdown = loadShutdown(source, {
      asr: async () => {
        calls.push('asr');
        throw new Error('ASR close failed');
      },
      extension: async () => {
        calls.push('extension');
      },
      loopback: async () => {
        calls.push('loopback');
      },
      mcp: async () => {
        calls.push('mcp');
        throw new Error('MCP cleanup failed');
      },
      process: async () => {
        calls.push('process');
      }
    });

    await shutdown().catch(() => undefined);

    expect(calls).toEqual(['mcp', 'extension', 'asr', 'process', 'loopback']);
  });

  it('closes ASR before waiting for the loopback server to drain active requests', async () => {
    const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
    const shutdown = source.slice(source.indexOf('async function shutdown'));

    expect(shutdown).toContain('await asrEngine?.close()');
    expect(shutdown.indexOf('await asrEngine?.close()')).toBeLessThan(shutdown.indexOf('await loopback?.close()'));
  });

  it('remembers and removes the MCP connection file before closing the loopback server', async () => {
    const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
    const shutdown = source.slice(source.indexOf('async function shutdown'));

    expect(source).toContain('let mcpConnectionFilePath: string | undefined;');
    expect(source).toContain('mcpConnectionFilePath = await writeMcpConnectionFile(');
    expect(shutdown).toContain('await removeMcpConnectionFileBestEffort(mcpConnectionFilePath)');
    expect(shutdown.indexOf('await removeMcpConnectionFileBestEffort'))
      .toBeLessThan(shutdown.indexOf('await extensionConnectionPublisher?.invalidate()'));
    expect(shutdown.indexOf('await removeMcpConnectionFileBestEffort'))
      .toBeLessThan(shutdown.indexOf('await loopback?.close()'));
  });
});

function loadShutdown(
  source: string,
  cleanup: Record<'asr' | 'extension' | 'loopback' | 'mcp' | 'process', () => Promise<void>>
): () => Promise<void> {
  const shutdownSource = source
    .slice(source.indexOf('async function shutdown'))
    .replace(': Promise<void>', '');
  const factory = new Function(
    'removeMcpConnectionFileBestEffort',
    'extensionConnectionPublisher',
    'asrEngine',
    'macProcessTapHost',
    'loopback',
    'reportShutdownError',
    `let mcpConnectionFilePath = 'mcp-connection.json';\n${shutdownSource}\nreturn shutdown;`
  ) as (...dependencies: unknown[]) => () => Promise<void>;

  return factory(
    cleanup.mcp,
    { invalidate: cleanup.extension },
    { close: cleanup.asr },
    { discardAll: cleanup.process },
    { close: cleanup.loopback },
    () => undefined
  );
}
