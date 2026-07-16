import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const extensionDirectory = new URL('..', import.meta.url);

describe('Chrome extension distribution build', () => {
  it('packages the local ASR worker and WASM runtime under a strict MV3 policy', async () => {
    await execFileAsync('npm', ['run', 'build'], { cwd: extensionDirectory });

    const manifest = JSON.parse(
      await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8')
    ) as {
      content_security_policy?: { extension_pages?: string };
      host_permissions?: string[];
      permissions?: string[];
    };

    expect(manifest.permissions).toContain('nativeMessaging');
    expect(manifest.host_permissions).not.toContain('<all_urls>');
    expect(manifest.content_security_policy?.extension_pages).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
    );

    const requiredFiles = [
      '../dist/asr-worker.js',
      '../dist/audio-worklet.js',
      '../dist/offscreen.js',
      '../dist/VOIVOX_LICENSE.txt',
      '../dist/THIRD_PARTY_NOTICES.md',
      '../dist/TRANSFORMERS_LICENSE.txt',
      '../dist/JINJA_LICENSE.txt',
      '../dist/ONNXRUNTIME_LICENSE.txt',
      '../dist/wasm/ort-wasm-simd-threaded.jsep.mjs',
      '../dist/wasm/ort-wasm-simd-threaded.jsep.wasm'
    ];
    for (const path of requiredFiles) {
      const file = new URL(path, import.meta.url);
      await expect(access(file)).resolves.toBeUndefined();
      expect((await stat(file)).size).toBeGreaterThan(0);
    }

    const jinjaLicense = await readFile(
      new URL('../dist/JINJA_LICENSE.txt', import.meta.url),
      'utf8'
    );
    expect(jinjaLicense).toContain('Copyright (c) 2023 Hugging Face');

    const popup = await readFile(new URL('../dist/popup.html', import.meta.url), 'utf8');
    const offscreen = await readFile(new URL('../dist/offscreen.html', import.meta.url), 'utf8');
    expect(`${popup}\n${offscreen}`).not.toMatch(/<script[^>]+src=["']https?:/iu);
  });
});
