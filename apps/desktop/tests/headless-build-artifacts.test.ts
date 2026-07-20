import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const workspace = fileURLToPath(new URL('../../..', import.meta.url));

describe('headless Voice VAC backend build', () => {
  it('declares a standalone headless entry without Electron or a visible window', async () => {
    const [source, packageSource] = await Promise.all([
      readFile(new URL('../headless/main.ts', import.meta.url), 'utf8').catch(() => ''),
      readFile(new URL('../package.json', import.meta.url), 'utf8')
    ]);
    const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> };

    expect(source).toContain('startVoiceVacBackend');
    expect(source).toContain('installHeadlessSignalHandlers');
    expect(source).not.toMatch(/(?:from\s+['"]electron['"]|BrowserWindow|createWindow)/u);
    expect(packageJson.scripts?.['build:headless']).toContain(
      'dist/headless/voice-vac-backend.mjs'
    );
    expect(packageJson.scripts?.build).toContain('build:headless');
    expect(packageJson.scripts?.['build:headless']).not.toMatch(/(?:pkg|nexe|node-bin)/iu);
  });

  it('builds one executable Node module without bundling Electron or a Node binary', async () => {
    await run('npm', ['run', 'build:headless', '--workspace=@voivox/desktop'], {
      cwd: workspace
    });
    const artifact = new URL('../dist/headless/voice-vac-backend.mjs', import.meta.url);
    const [source, artifactStat, entries] = await Promise.all([
      readFile(artifact, 'utf8'),
      stat(artifact),
      readdir(new URL('../dist/headless/', import.meta.url))
    ]);

    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(source).not.toMatch(/(?:from\s+['"]electron['"]|require\(['"]electron['"]\)|BrowserWindow)/u);
    expect(source).toContain('Voice VAC backend');
    expect(artifactStat.mode & 0o111).not.toBe(0);
    expect(entries).toEqual(['voice-vac-backend.mjs']);
    await expect(run(process.execPath, ['--check', fileURLToPath(artifact)]))
      .resolves.toMatchObject({ stderr: '' });
  });
});
