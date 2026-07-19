import { readFile, readdir } from 'node:fs/promises';
import { extname } from 'node:path';

import { describe, expect, it } from 'vitest';

const forbidden = /chrome\.debugger|Runtime\.evaluate|Input\.dispatchMouseEvent|["']debugger["']/u;

describe('Store capability boundary', () => {
  it('contains no debugger permission or CDP bytes', async () => {
    const storeRoot = new URL('../dist/store/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', storeRoot), 'utf8')) as {
      permissions: string[];
    };

    expect(manifest.permissions).not.toContain('debugger');

    for (const sourceUrl of await javaScriptFiles(storeRoot)) {
      expect(await readFile(sourceUrl, 'utf8'), sourceUrl.pathname).not.toMatch(forbidden);
    }
  });

  it('keeps Automation code out of the Store composition root', async () => {
    const source = await readFile(new URL('../src/service-worker.store.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/automation|cdp|debugger/iu);
    expect(source).toContain("./service-worker-core.js");
  });
});

async function javaScriptFiles(directoryUrl: URL): Promise<URL[]> {
  const files: URL[] = [];

  for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
    const entryUrl = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directoryUrl);
    if (entry.isDirectory()) {
      files.push(...await javaScriptFiles(entryUrl));
    } else if (extname(entry.name) === '.js' || extname(entry.name) === '.mjs') {
      files.push(entryUrl);
    }
  }

  return files;
}
