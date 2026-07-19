import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const desktopDirectory = new URL('..', import.meta.url);
const COLD_DESKTOP_BUILD_TIMEOUT_MS = 120_000;

describe('desktop distribution build', () => {
  it('loads the renderer and sandboxed preload from packaged file URLs', async () => {
    const resourcesDirectory = new URL('./dist/resources/', desktopDirectory);
    const staleMarker = new URL('./dist/resources/REVIEW_STALE_MODEL_DIR_MARKER', desktopDirectory);
    await mkdir(resourcesDirectory, { recursive: true });
    await writeFile(staleMarker, 'must be removed before packaging', 'utf8');

    await run('npm', ['run', 'build', '--workspace=@voivox/desktop'], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url))
    });

    const [
      rendererHtml,
      preload,
      qwenRuntime,
      qwenWorker,
      mcpLauncher,
      mcpBundle,
      mcpLauncherStat,
      mcpLicense,
      zodLicense,
      reactLicense,
      electronLicense,
      electronChromiumNotices
    ] = await Promise.all([
      readFile(new URL('./dist/renderer/index.html', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/electron/preload.js', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/qwen_runtime.py', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/voivox_asr_worker.py', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/voivox-mcp', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/voivox-mcp.mjs', desktopDirectory), 'utf8'),
      stat(new URL('./dist/resources/voivox-mcp', desktopDirectory)),
      readFile(new URL('./dist/resources/MCP_SDK_LICENSE.txt', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/ZOD_LICENSE.txt', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/REACT_LICENSE.txt', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/ELECTRON_LICENSE.txt', desktopDirectory), 'utf8'),
      readFile(new URL('./dist/resources/ELECTRON_CHROMIUM_NOTICES.html', desktopDirectory), 'utf8')
    ]);

    expect(rendererHtml).toContain('src="./assets/');
    expect(rendererHtml).toContain('href="./assets/');
    expect(preload).not.toMatch(/^import\s/m);
    expect(qwenRuntime).toContain('class QwenRuntime');
    expect(qwenWorker).toContain('VOICE_VAC_QWEN_MODEL_PATH');
    expect(qwenWorker).not.toContain('mlx_qwen3_asr');
    expect(mcpLauncher).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(mcpBundle).toContain('Voice Vac status');
    expect(mcpLauncherStat.mode & 0o111).not.toBe(0);
    expect(mcpLicense).toContain('Anthropic, PBC');
    expect(zodLicense).toContain('Colin McDonnell');
    expect(reactLicense).toContain('Meta Platforms');
    expect(electronLicense).toContain('Electron contributors');
    expect(electronChromiumNotices).toContain('Chromium software is made available as source code');
    await expect(access(staleMarker)).rejects.toMatchObject({ code: 'ENOENT' });

    const packagedResourceNames = await listRelativeFiles(resourcesDirectory);
    expect(packagedResourceNames).not.toContain('TRANSFORMERS_LICENSE.txt');
    expect(packagedResourceNames).not.toContain('ONNXRUNTIME_LICENSE.txt');
    expect(packagedResourceNames.some((name) => /(?:^|\/)(?:models|asr-venv)(?:\/|$)/u.test(name))).toBe(false);
    expect(packagedResourceNames.some((name) => /\.(?:bin|gguf|onnx|safetensors)$/iu.test(name))).toBe(false);

    const requiredLicenses = [
      'VACVOX_LICENSE.txt',
      'AJV_LICENSE.txt',
      'AJV_FORMATS_LICENSE.txt',
      'FAST_DEEP_EQUAL_LICENSE.txt',
      'FAST_URI_LICENSE.txt',
      'JSON_SCHEMA_TRAVERSE_LICENSE.txt',
      'ZOD_TO_JSON_SCHEMA_LICENSE.txt',
      'REACT_DOM_LICENSE.txt'
    ];
    for (const license of requiredLicenses) {
      await expect(access(new URL(`./dist/resources/${license}`, desktopDirectory)))
        .resolves.toBeUndefined();
    }
  }, COLD_DESKTOP_BUILD_TIMEOUT_MS);
});

async function listRelativeFiles(directory: URL, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(new URL(`${entry.name}/`, directory), relative));
    } else {
      files.push(relative);
    }
  }
  return files;
}
