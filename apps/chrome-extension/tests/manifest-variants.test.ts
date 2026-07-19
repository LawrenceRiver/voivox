import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

function extensionId(key: string): string {
  return [...createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest()
    .subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}

describe('Voice VAC manifest variants', () => {
  it('pins independent Store and Automation identities and permissions', async () => {
    const store = JSON.parse(
      await readFile(new URL('../config/manifest.store.json', import.meta.url), 'utf8')
    ) as { key: string; permissions: string[] };
    const automation = JSON.parse(
      await readFile(new URL('../config/manifest.automation.json', import.meta.url), 'utf8')
    ) as { key: string; permissions: string[] };

    expect(extensionId(store.key)).toBe('pepfpbobjbjehhhcjiokmneclohlffno');
    expect(extensionId(automation.key)).toBe('ciijinidnlbokpbeiabifcnoighmbnmh');
    expect(store.permissions).toEqual([
      'activeTab',
      'nativeMessaging',
      'offscreen',
      'scripting',
      'storage',
      'tabCapture'
    ]);
    expect(store.permissions).not.toContain('debugger');
    expect(automation.permissions).toEqual([...store.permissions, 'debugger']);
  });

  it('keeps identity and permissions out of the common manifest', async () => {
    const common = JSON.parse(
      await readFile(new URL('../config/manifest.base.json', import.meta.url), 'utf8')
    ) as Record<string, unknown>;

    expect(common).not.toHaveProperty('key');
    expect(common).not.toHaveProperty('permissions');
    expect(common).not.toHaveProperty('version');
  });
});
