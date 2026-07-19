import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import {
  QWEN_MODEL_INSTALL,
  resolvePythonCommand,
  resolveQwenModelPath
} from '../src/main/python-runtime.js';

describe('local ASR Python runtime selection', () => {
  it('prefers an explicit override for advanced installations', () => {
    expect(resolvePythonCommand('/Library/Application Support/Voice Vac', '/custom/python', () => true)).toBe('/custom/python');
  });

  it('uses the Voice Vac-managed virtual environment after the installer runs', () => {
    expect(
      resolvePythonCommand('/Library/Application Support/Voice Vac', undefined, (path) =>
        path === '/Library/Application Support/Voice Vac/asr-venv/bin/python'
      )
    ).toBe('/Library/Application Support/Voice Vac/asr-venv/bin/python');
  });

  it('falls back to the system Python with a clear installer path available', () => {
    expect(resolvePythonCommand('/Library/Application Support/Voice Vac', undefined, () => false)).toBe('python3');
  });

  it('pins the official Qwen model and external snapshot revision', () => {
    expect(QWEN_MODEL_INSTALL).toEqual({
      directoryName: 'Qwen3-ASR-0.6B',
      repoId: 'Qwen/Qwen3-ASR-0.6B',
      revision: '5eb144179a02acc5e5ba31e748d22b0cf3e303b0'
    });
  });

  it('accepts only a matching external manifest plus model config', () => {
    const dataPath = '/Library/Application Support/Voice VAC';
    const modelPath = `${dataPath}/models/Qwen3-ASR-0.6B`;
    const manifestPath = `${modelPath}/model-manifest.json`;
    const configPath = `${modelPath}/config.json`;
    const files = new Map([
      [manifestPath, JSON.stringify({
        schemaVersion: 1,
        repoId: QWEN_MODEL_INSTALL.repoId,
        revision: QWEN_MODEL_INSTALL.revision,
        modelPath,
        configSha256: createHash('sha256').update('{}').digest('hex'),
        installedAt: '2026-07-19T00:00:00.000Z'
      })],
      [configPath, '{}']
    ]);
    const fileSystem = {
      exists: (path: string) => files.has(path),
      readText: (path: string) => files.get(path) ?? ''
    };

    expect(resolveQwenModelPath(dataPath, undefined, fileSystem)).toBe(modelPath);
    files.set(manifestPath, JSON.stringify({
      schemaVersion: 1,
      repoId: QWEN_MODEL_INSTALL.repoId,
      revision: 'wrong-revision',
      modelPath,
      configSha256: createHash('sha256').update('{}').digest('hex'),
      installedAt: '2026-07-19T00:00:00.000Z'
    }));
    expect(resolveQwenModelPath(dataPath, undefined, fileSystem)).toBeUndefined();
  });

  it('refuses a model directory without its manifest or config', () => {
    const missing = { exists: () => false, readText: () => '' };
    expect(resolveQwenModelPath('/data', undefined, missing)).toBeUndefined();
  });
});
