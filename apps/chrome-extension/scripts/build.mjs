import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const channel = process.argv[2];

if (channel !== 'store' && channel !== 'automation') {
  throw new Error('Usage: node scripts/build.mjs <store|automation>');
}

const outputDirectory = join(extensionRoot, 'dist', channel);
const packageJson = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
const baseManifest = JSON.parse(
  await readFile(join(extensionRoot, 'config', 'manifest.base.json'), 'utf8')
);
const variantManifest = JSON.parse(
  await readFile(join(extensionRoot, 'config', `manifest.${channel}.json`), 'utf8')
);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  absWorkingDir: extensionRoot,
  bundle: true,
  entryNames: '[name]',
  entryPoints: {
    popup: 'src/popup.ts',
    'service-worker': `src/service-worker.${channel}.ts`,
    offscreen: 'src/offscreen.ts',
    'audio-worklet': 'src/audio-worklet.ts',
    'asr-worker': 'src/asr-worker.ts',
    'content-tunnel': 'src/content-tunnel.ts'
  },
  format: 'esm',
  outdir: outputDirectory,
  platform: 'browser',
  target: 'chrome116'
});

const manifest = {
  ...baseManifest,
  ...variantManifest,
  version: packageJson.version,
  background: { service_worker: 'service-worker.js', type: 'module' },
  permissions: variantManifest.permissions
};
await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const copies = [
  ['public/popup.html', 'popup.html'],
  ['public/popup.css', 'popup.css'],
  ['public/offscreen.html', 'offscreen.html'],
  ['public/content-tunnel.css', 'content-tunnel.css'],
  ['public/icon.png', 'icon.png'],
  ['../../THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['../../LICENSE', 'VACVOX_LICENSE.txt'],
  ['../../node_modules/@huggingface/transformers/LICENSE', 'TRANSFORMERS_LICENSE.txt'],
  ['../../node_modules/@huggingface/jinja/LICENSE', 'JINJA_LICENSE.txt'],
  ['../../licenses/onnxruntime-MIT.txt', 'ONNXRUNTIME_LICENSE.txt'],
  [
    '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs',
    'wasm/ort-wasm-simd-threaded.jsep.mjs'
  ],
  [
    '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm',
    'wasm/ort-wasm-simd-threaded.jsep.wasm'
  ]
];

for (const [source, destination] of copies) {
  const target = join(outputDirectory, destination);
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(extensionRoot, source), target);
}
