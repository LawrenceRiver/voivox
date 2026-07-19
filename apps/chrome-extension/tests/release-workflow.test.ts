import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Voice VAC release workflow', () => {
  it('packages, checksums, uploads, and publishes both extension channels', async () => {
    const workflow = await readFile(
      new URL('../../../.github/workflows/package-macos.yml', import.meta.url),
      'utf8'
    );

    expect(workflow).toContain('npm run package:store --workspace=@voivox/chrome-extension');
    expect(workflow).toContain('npm run package:automation --workspace=@voivox/chrome-extension');
    expect(workflow.match(/Voice-VAC-Store-\*\.zip/gu)).toHaveLength(3);
    expect(workflow.match(/Voice-VAC-Automation-\*\.zip/gu)).toHaveLength(3);
    expect(workflow).not.toContain('VoiceVac-Chrome-Extension-*.zip');
  });
});
