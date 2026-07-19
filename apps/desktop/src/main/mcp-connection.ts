import { rm } from 'node:fs/promises';

type RemoveFile = (filePath: string, options: { force: true }) => Promise<void>;

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
