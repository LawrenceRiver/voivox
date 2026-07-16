import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('desktop package configuration', () => {
  it('pins the Electron version used by electron-builder', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      build?: {
        electronVersion?: unknown;
        mac?: { hardenedRuntime?: unknown; identity?: unknown };
      };
    };

    expect(packageJson.build?.electronVersion).toEqual(expect.stringMatching(/^\d+\.\d+\.\d+$/));
    expect(packageJson.build?.mac).toMatchObject({
      hardenedRuntime: false,
      identity: '-'
    });
  });
});
