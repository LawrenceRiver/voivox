import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

type RemoveFile = (filePath: string, options: { force: true }) => Promise<void>;

export async function writeMcpConnectionFile(
  directory: string,
  baseUrl: string,
  token: string
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, 'mcp-connection.json');
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ baseUrl, token }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
    return filePath;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function removeMcpConnectionFileBestEffort(
  filePath: string | undefined,
  options: {
    onError?: (error: unknown) => void;
    remove?: RemoveFile;
  } = {}
): Promise<void> {
  if (!filePath) {
    return;
  }
  try {
    await (options.remove ?? rm)(filePath, { force: true });
  } catch (error) {
    (options.onError ?? defaultErrorReporter)(error);
  }
}

function defaultErrorReporter(error: unknown): void {
  console.warn(
    'Voice Vac could not remove its stale MCP connection file:',
    error instanceof Error ? error.message : 'Unknown removal failure.'
  );
}
