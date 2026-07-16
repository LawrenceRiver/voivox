import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('desktop preload capabilities contract', () => {
  it('exposes desktop capabilities without exposing Electron primitives', async () => {
    const [preload, main] = await Promise.all([
      readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8'),
      readFile(new URL('../electron/main.ts', import.meta.url), 'utf8')
    ]);

    expect(preload).toContain("getCapabilities: () => ipcRenderer.invoke('voivox:get-capabilities')");
    expect(preload).not.toContain('getChromeBridge');
    expect(preload).not.toContain('voivox:get-chrome-bridge');
    expect(main).not.toContain('voivox:get-chrome-bridge');
  });
});
