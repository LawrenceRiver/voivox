import { readFile } from 'node:fs/promises';

import { VoiceVacError } from '@voivox/core';
import { describe, expect, it, vi } from 'vitest';

import { startLocalAsrCapabilityProbe } from '../src/main/local-asr-capability.js';

describe('local ASR capability probe', () => {
  it('stays checking until the same engine has actually loaded and emitted ready', async () => {
    let ready: (() => void) | undefined;
    let engineStatus = 'model_loading' as 'model_loading' | 'ready';
    const engine = {
      getStatus: vi.fn(() => engineStatus),
      start: vi.fn(() => new Promise<void>((resolve) => { ready = resolve; }))
    };

    const probe = startLocalAsrCapabilityProbe(engine);
    expect(probe.getStatus()).toBe('checking');
    expect(engine.start).toHaveBeenCalledOnce();

    engineStatus = 'ready';
    ready?.();
    await expect(probe.completion).resolves.toBe('ready');
    expect(probe.getStatus()).toBe('ready');
  });

  it('reports missing when that engine emits a typed fatal failure', async () => {
    const fatal = new VoiceVacError('ASR_MODEL_LOAD_FAILED');
    const engine = {
      getStatus: () => 'fatal' as const,
      start: () => Promise.reject(fatal)
    };
    const probe = startLocalAsrCapabilityProbe(engine);

    await expect(probe.completion).resolves.toBe('missing');
    expect(probe.getStatus()).toBe('missing');
  });

  it('downgrades readiness if the same worker later becomes fatal', async () => {
    let engineStatus = 'ready' as 'ready' | 'fatal';
    const probe = startLocalAsrCapabilityProbe({
      getStatus: () => engineStatus,
      start: async () => undefined
    });
    await expect(probe.completion).resolves.toBe('ready');

    engineStatus = 'fatal';
    expect(probe.getStatus()).toBe('missing');
  });

  it('keeps the legacy string call type-safe but never mistakes find_spec for readiness', async () => {
    const probe = startLocalAsrCapabilityProbe('/managed/python');
    await expect(probe.completion).resolves.toBe('missing');
  });

  it('contains no find_spec subprocess probe', async () => {
    const source = await readFile(new URL('../src/main/local-asr-capability.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('find_spec');
    expect(source).not.toContain('child_process');
  });

  it('wires the validated external model path into the exact probed engine', async () => {
    const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
    expect(source).toContain('resolveQwenModelPath');
    expect(source).toMatch(/modelPath[,\s]/u);
    expect(source).toContain('startLocalAsrCapabilityProbe(asrEngine)');
    expect(source).not.toContain('startLocalAsrCapabilityProbe(pythonCommand)');
  });
});
