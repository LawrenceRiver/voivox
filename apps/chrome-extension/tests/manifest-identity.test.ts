import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Chrome extension identity', () => {
  it('pins the public key that produces the stable Voice Vac extension origin', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../public/manifest.json', import.meta.url), 'utf8')
    ) as { key?: unknown };

    expect(typeof manifest.key).toBe('string');
    const publicKey = Buffer.from(manifest.key as string, 'base64');
    const idBytes = createHash('sha256').update(publicKey).digest().subarray(0, 16);
    const extensionId = [...idBytes]
      .flatMap((byte) => [byte >> 4, byte & 0x0f])
      .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
      .join('');

    expect(extensionId).toBe('pepfpbobjbjehhhcjiokmneclohlffno');
  });
});
