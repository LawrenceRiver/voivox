import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('macOS package metadata', () => {
  it('explains why Voice Vac needs permission to capture the selected app audio', async () => {
    const packageFile = new URL('../package.json', import.meta.url);
    const manifest = JSON.parse(await readFile(packageFile, 'utf8')) as {
      build?: { mac?: { extendInfo?: Record<string, string> } };
    };

    const usageDescription = manifest.build?.mac?.extendInfo?.NSAudioCaptureUsageDescription;
    expect(usageDescription).toBeDefined();
    expect(usageDescription).toContain('所选应用');
  });
});
