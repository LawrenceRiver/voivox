import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const extensionDirectory = new URL('..', import.meta.url);

function extensionId(key: string): string {
  return [...createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest()
    .subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('Chrome extension distribution build', () => {
  it.each(['store', 'automation'] as const)(
    'packages the %s desktop PCM relay without a browser ASR runtime',
    async (channel) => {
      await execFileAsync('npm', ['run', `build:${channel}`], { cwd: extensionDirectory });

      const manifest = JSON.parse(
        await readFile(new URL(`../dist/${channel}/manifest.json`, import.meta.url), 'utf8')
      ) as {
        content_security_policy?: { extension_pages?: string };
        host_permissions?: string[];
        permissions?: string[];
      };

      expect(manifest.permissions).toContain('nativeMessaging');
      expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*']);
      expect(manifest.content_security_policy?.extension_pages).toBe(
        "script-src 'self'; object-src 'self'"
      );

      const requiredFiles = [
        'audio-worklet.js',
        'offscreen.js',
        'VACVOX_LICENSE.txt'
      ];
      for (const path of requiredFiles) {
        const file = new URL(`../dist/${channel}/${path}`, import.meta.url);
        await expect(access(file)).resolves.toBeUndefined();
        expect((await stat(file)).size).toBeGreaterThan(0);
      }

      for (const removed of [
        'asr-worker.js',
        'TRANSFORMERS_LICENSE.txt',
        'JINJA_LICENSE.txt',
        'ONNXRUNTIME_LICENSE.txt',
        'wasm/ort-wasm-simd-threaded.jsep.mjs',
        'wasm/ort-wasm-simd-threaded.jsep.wasm'
      ]) {
        await expect(access(new URL(`../dist/${channel}/${removed}`, import.meta.url))).rejects.toThrow();
        await expect(access(new URL(`../dist/${removed}`, import.meta.url))).rejects.toThrow();
      }

      const popup = await readFile(
        new URL(`../dist/${channel}/popup.html`, import.meta.url),
        'utf8'
      );
      const offscreen = await readFile(
        new URL(`../dist/${channel}/offscreen.html`, import.meta.url),
        'utf8'
      );
      expect(`${popup}\n${offscreen}`).not.toMatch(/<script[^>]+src=["']https?:/iu);
      expect(popup).not.toMatch(/(?:45|80)\s*MB/iu);

      const builtSources = await Promise.all([
        'offscreen.js',
        'service-worker.js',
        'popup.js'
      ].map((path) => readFile(new URL(`../dist/${channel}/${path}`, import.meta.url), 'utf8')));
      expect(builtSources.join('\n')).not.toMatch(
        /(?:whisper|huggingface|transformers|asr-worker\.js|new\s+Worker\s*\()/iu
      );

      const contentTunnel = await readFile(
        new URL(`../dist/${channel}/content-tunnel.js`, import.meta.url),
        'utf8'
      );
      expect(contentTunnel).not.toMatch(/^\s*(?:import|export)\s/mu);
      expect(contentTunnel).toContain('registerContentTunnelRuntime();');

      const packageJson = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8')
      ) as { dependencies?: Record<string, string> };
      expect(packageJson.dependencies).not.toHaveProperty('@huggingface/transformers');
    }
  );

  it.each([
    {
      channel: 'store',
      expectedId: 'pepfpbobjbjehhhcjiokmneclohlffno',
      expectedName: 'Voice VAC',
      fileName: 'Voice-VAC-Store-0.1.1.zip',
      permissions: ['activeTab', 'nativeMessaging', 'offscreen', 'scripting', 'storage', 'tabCapture']
    },
    {
      channel: 'automation',
      expectedId: 'ciijinidnlbokpbeiabifcnoighmbnmh',
      expectedName: 'Voice VAC Automation',
      fileName: 'Voice-VAC-Automation-0.1.1.zip',
      permissions: [
        'activeTab',
        'nativeMessaging',
        'offscreen',
        'scripting',
        'storage',
        'tabCapture',
        'debugger'
      ]
    }
  ] as const)(
    'packages the $channel archive with the expected identity and exact capability set',
    async ({ channel, expectedId, expectedName, fileName, permissions }) => {
      await execFileAsync('npm', ['run', `package:${channel}`], { cwd: extensionDirectory });
      const archiveBytes = await readFile(new URL(`../release/${fileName}`, import.meta.url));
      const entries = unzipSync(archiveBytes);
      const manifestBytes = entries['manifest.json'];
      expect(manifestBytes).toBeDefined();
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
        key: string;
        name: string;
        permissions: string[];
        version: string;
      };

      expect(extensionId(manifest.key)).toBe(expectedId);
      expect(manifest.name).toBe(expectedName);
      expect(manifest.permissions).toEqual(permissions);
      expect(manifest.version).toBe('0.1.1');
      expect(Object.keys(entries).sort()).toContain('service-worker.js');
    }
  );

  it('produces byte-identical Store archives from identical sources', async () => {
    const archive = new URL('../release/Voice-VAC-Store-0.1.1.zip', import.meta.url);
    await execFileAsync('npm', ['run', 'package:store'], { cwd: extensionDirectory });
    const firstHash = sha256(await readFile(archive));

    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await execFileAsync('npm', ['run', 'package:store'], { cwd: extensionDirectory });
    expect(sha256(await readFile(archive))).toBe(firstHash);
  }, 15_000);
});
