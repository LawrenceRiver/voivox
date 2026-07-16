import { describe, expect, it, vi } from 'vitest';

type RemoveMcpConnectionFileBestEffort = (
  filePath: string | undefined,
  options?: {
    onError?: (error: unknown) => void;
    remove?: (filePath: string, options: { force: true }) => Promise<void>;
  }
) => Promise<void>;

async function loadRemoveHelper(): Promise<RemoveMcpConnectionFileBestEffort | undefined> {
  const moduleUrl = new URL('../src/main/mcp-connection.ts', import.meta.url).href;
  const module = await import(/* @vite-ignore */ moduleUrl).catch(() => ({}));
  return (module as { removeMcpConnectionFileBestEffort?: RemoveMcpConnectionFileBestEffort })
    .removeMcpConnectionFileBestEffort;
}

describe('MCP connection-file cleanup', () => {
  it('awaits removal before shutdown cleanup resolves', async () => {
    const removeMcpConnectionFileBestEffort = await loadRemoveHelper();
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
    const removeMcpConnectionFileBestEffort = await loadRemoveHelper();
    expect(removeMcpConnectionFileBestEffort).toBeTypeOf('function');
    const error = new Error('simulated read-only file');
    const onError = vi.fn();

    await expect(removeMcpConnectionFileBestEffort?.('/tmp/mcp-connection.json', {
      onError,
      remove: vi.fn().mockRejectedValue(error)
    })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(error);
  });
});
