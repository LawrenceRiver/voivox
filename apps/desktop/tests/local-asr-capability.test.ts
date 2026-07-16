import { describe, expect, it, vi } from 'vitest';

import { startLocalAsrCapabilityProbe } from '../src/main/local-asr-capability.js';

describe('local ASR capability probe', () => {
  it('reports checking before find_spec confirms the lightweight runtime is ready', async () => {
    let finish: ((exitCode: number) => void) | undefined;
    const run = vi.fn().mockImplementation(() => new Promise<number>((resolve) => {
      finish = resolve;
    }));

    const probe = startLocalAsrCapabilityProbe('/managed/python', run);

    expect(probe.getStatus()).toBe('checking');
    expect(run).toHaveBeenCalledOnce();
    const [pythonCommand, args] = run.mock.calls[0] as [string, string[]];
    expect(pythonCommand).toBe('/managed/python');
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain("importlib.util.find_spec('mlx_qwen3_asr')");
    expect(args[1]).not.toMatch(/(^|\n)\s*import mlx_qwen3_asr/);

    finish?.(0);
    await expect(probe.completion).resolves.toBe('ready');
    expect(probe.getStatus()).toBe('ready');
  });

  it('reports missing when find_spec cannot locate the runtime', async () => {
    const probe = startLocalAsrCapabilityProbe('python3', async () => 1);

    await expect(probe.completion).resolves.toBe('missing');
    expect(probe.getStatus()).toBe('missing');
  });

  it('reports missing when Python cannot be started', async () => {
    const probe = startLocalAsrCapabilityProbe('python3', async () => {
      throw new Error('spawn failed');
    });

    await expect(probe.completion).resolves.toBe('missing');
    expect(probe.getStatus()).toBe('missing');
  });
});
