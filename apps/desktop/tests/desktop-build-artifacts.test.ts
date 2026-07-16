import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const desktopDirectory = new URL('..', import.meta.url);

describe('desktop distribution build', () => {
  it('loads the renderer and sandboxed preload from packaged file URLs', async () => {
    await run('npm', ['run', 'build', '--workspace=@voivox/desktop'], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url))
    });

    const [rendererHtml, preload] = await Promise.all([
      readFile(new URL('./dist/renderer/index.html', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/electron/preload.js', desktopDirectory), 'utf8')
    ]);

    expect(rendererHtml).toContain('src="./assets/');
    expect(rendererHtml).toContain('href="./assets/');
    expect(preload).not.toMatch(/^import\s/m);
  }, 30_000);
});
