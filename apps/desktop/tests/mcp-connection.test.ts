import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

type RemoveMcpConnectionFileBestEffort = (
  filePath: string | undefined,
  options?: {
    onError?: (error: unknown) => void;
    remove?: (filePath: string, options: { force: true }) => Promise<void>;
  }
) => Promise<void>;

type WriteMcpConnectionFile = (
  directory: string,
  baseUrl: string,
  token: string
) => Promise<string>;

async function loadMcpConnectionModule(): Promise<{
  removeMcpConnectionFileBestEffort?: RemoveMcpConnectionFileBestEffort;
  writeMcpConnectionFile?: WriteMcpConnectionFile;
}> {
  const moduleUrl = new URL('../src/main/mcp-connection.ts', import.meta.url).href;
  return import(/* @vite-ignore */ moduleUrl).catch(() => ({}));
}

describe('MCP connection-file cleanup', () => {
  it('awaits removal before shutdown cleanup resolves', async () => {
    const { removeMcpConnectionFileBestEffort } = await loadMcpConnectionModule();
    expect(removeMcpConnectionFileBestEffort).toBeTypeOf('function');
    let releaseRemoval: (() => void) | undefined;
    const remove = vi.fn(() => new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    }));
    let settled = false;

    const cleanup = removeMcpConnectionFileBestEffort?.('/tmp/mcp-connection.json', { remove });
    void cleanup?.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(remove).toHaveBeenCalledWith('/tmp/mcp-connection.json', { force: true });
    expect(settled).toBe(false);
    releaseRemoval?.();
    await cleanup;
    expect(settled).toBe(true);
  });

  it('does not block shutdown when removal fails', async () => {
    const { removeMcpConnectionFileBestEffort } = await loadMcpConnectionModule();
    expect(removeMcpConnectionFileBestEffort).toBeTypeOf('function');
    const error = new Error('simulated read-only file');
    const onError = vi.fn();

    await expect(removeMcpConnectionFileBestEffort?.('/tmp/mcp-connection.json', {
      onError,
      remove: vi.fn().mockRejectedValue(error)
    })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('writes the exact MCP connection atomically with owner-only permissions', async () => {
    const { writeMcpConnectionFile } = await loadMcpConnectionModule();
    expect(writeMcpConnectionFile).toBeTypeOf('function');
    const directory = await mkdtemp(join(tmpdir(), 'voice-vac-mcp-'));
    try {
      const filePath = await writeMcpConnectionFile?.(
        directory,
        'http://127.0.0.1:43817',
        'primary-token'
      );

      expect(filePath).toBe(join(directory, 'mcp-connection.json'));
      expect(JSON.parse(await readFile(filePath!, 'utf8'))).toEqual({
        baseUrl: 'http://127.0.0.1:43817',
        token: 'primary-token'
      });
      expect((await stat(filePath!)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
