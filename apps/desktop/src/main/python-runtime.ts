import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const QWEN_MODEL_INSTALL = Object.freeze({
  directoryName: 'Qwen3-ASR-0.6B',
  repoId: 'Qwen/Qwen3-ASR-0.6B',
  revision: '5eb144179a02acc5e5ba31e748d22b0cf3e303b0'
});

export type RuntimeFileSystem = {
  exists: (path: string) => boolean;
  readText: (path: string) => string;
};

export function resolvePythonCommand(
  dataPath: string,
  override: string | undefined,
  fileExists: (path: string) => boolean = existsSync
): string {
  if (override) {
    return override;
  }

  const managedRuntime = join(dataPath, 'asr-venv', 'bin', 'python');
  return fileExists(managedRuntime) ? managedRuntime : 'python3';
}

export function resolveQwenModelPath(
  dataPath: string,
  override: string | undefined,
  fileSystem: RuntimeFileSystem = {
    exists: existsSync,
    readText: (path) => readFileSync(path, 'utf8')
  }
): string | undefined {
  const modelPath = resolve(override ?? join(dataPath, 'models', QWEN_MODEL_INSTALL.directoryName));
  const manifestPath = join(modelPath, 'model-manifest.json');
  const configPath = join(modelPath, 'config.json');
  if (!fileSystem.exists(manifestPath) || !fileSystem.exists(configPath)) return undefined;

  try {
    const manifest = JSON.parse(fileSystem.readText(manifestPath)) as unknown;
    const configText = fileSystem.readText(configPath);
    const config = JSON.parse(configText) as unknown;
    if (!isRecord(manifest) || !isRecord(config)) return undefined;
    const installedAt = manifest.installedAt;
    return manifest.schemaVersion === 1
      && manifest.repoId === QWEN_MODEL_INSTALL.repoId
      && manifest.revision === QWEN_MODEL_INSTALL.revision
      && manifest.modelPath === modelPath
      && typeof manifest.configSha256 === 'string'
      && manifest.configSha256 === createHash('sha256').update(configText, 'utf8').digest('hex')
      && typeof installedAt === 'string'
      && Number.isFinite(Date.parse(installedAt))
      ? modelPath
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
