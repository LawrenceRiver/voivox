import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const desktopDirectory = new URL('..', import.meta.url);
const COLD_DESKTOP_BUILD_TIMEOUT_MS = 120_000;

describe('desktop distribution build', () => {
  it('loads the renderer and sandboxed preload from packaged file URLs', async () => {
    await run('npm', ['run', 'build', '--workspace=@voivox/desktop'], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url))
    });

    const [
      rendererHtml,
      preload,
      mcpLauncher,
      mcpBundle,
      mcpLauncherStat,
      mcpLicense,
      zodLicense,
      reactLicense,
      electronLicense,
      electronChromiumNotices
    ] = await Promise.all([
      readFile(new URL('./dist/renderer/index.html', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/electron/preload.js', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/voivox-mcp', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/voivox-mcp.mjs', desktopDirectory), 'utf8'),
      stat(new URL('./dist/resources/voivox-mcp', desktopDirectory)),
      readFile(new URL('./dist/resources/MCP_SDK_LICENSE.txt', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/ZOD_LICENSE.txt', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/REACT_LICENSE.txt', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/ELECTRON_LICENSE.txt', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/ELECTRON_CHROMIUM_NOTICES.html', desktopDirectory), 'utf8')
    ]);

    expect(rendererHtml).toContain('src="./assets/');
    expect(rendererHtml).toContain('href="./assets/');
    expect(preload).not.toMatch(/^import\s/m);
    expect(mcpLauncher).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(mcpBundle).toContain('VOIVOX status');
    expect(mcpLauncherStat.mode & 0o111).not.toBe(0);
    expect(mcpLicense).toContain('Anthropic, PBC');
    expect(zodLicense).toContain('Colin McDonnell');
    expect(reactLicense).toContain('Meta Platforms');
    expect(electronLicense).toContain('Electron contributors');
    expect(electronChromiumNotices).toContain('Chromium software is made available as source code');

    const requiredLicenses = [
      'VOIVOX_LICENSE.txt',
      'AJV_LICENSE.txt',
      'AJV_FORMATS_LICENSE.txt',
      'FAST_DEEP_EQUAL_LICENSE.txt',
      'FAST_URI_LICENSE.txt',
      'JSON_SCHEMA_TRAVERSE_LICENSE.txt',
      'ZOD_TO_JSON_SCHEMA_LICENSE.txt',
      'REACT_DOM_LICENSE.txt'
    ];
    for (const license of requiredLicenses) {
      await expect(access(new URL(`./dist/resources/${license}`, desktopDirectory)))
        .resolves.toBeUndefined();
    }
  }, COLD_DESKTOP_BUILD_TIMEOUT_MS);
});
