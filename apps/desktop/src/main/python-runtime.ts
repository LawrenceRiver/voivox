import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
