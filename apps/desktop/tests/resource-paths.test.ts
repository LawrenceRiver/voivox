import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveBundledResource, resolveElectronEntryPoints } from '../electron/resource-paths.js';

describe('resolveBundledResource', () => {
  it('uses the copied macOS resource directory in a packaged app', () => {
    expect(
      resolveBundledResource('voivox-host', {
        isPackaged: true,
        moduleUrl: 'file:///ignored/main.js',
        resourcesPath: '/Applications/VOIVOX.app/Contents/Resources'
      })
    ).toBe(join('/Applications/VOIVOX.app/Contents/Resources', 'voivox', 'voivox-host'));
  });

  it('uses the local dist resources directory during development', () => {
    expect(
      resolveBundledResource('voivox_asr_worker.py', {
        isPackaged: false,
        moduleUrl: 'file:///workspace/apps/desktop/dist/electron/main.js',
        resourcesPath: '/ignored'
      })
    ).toBe('/workspace/apps/desktop/dist/resources/voivox_asr_worker.py');
  });
});

describe('resolveElectronEntryPoints', () => {
  it('returns decoded filesystem paths when the project directory contains Chinese characters', () => {
    expect(
      resolveElectronEntryPoints(
        'file:///Users/demo/%E4%B8%AA%E4%BA%BA%E7%BD%91%E9%A1%B5/voivox/dist/electron/main.js'
      )
    ).toEqual({
      preload: '/Users/demo/个人网页/voivox/dist/electron/preload.js',
      renderer: '/Users/demo/个人网页/voivox/dist/renderer/index.html'
    });
  });
});
