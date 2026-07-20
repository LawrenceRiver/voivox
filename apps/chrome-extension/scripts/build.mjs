import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const channel = process.argv[2];

if (channel !== 'store' && channel !== 'automation') {
  throw new Error('Usage: node scripts/build.mjs <store|automation>');
}

const distributionRoot = join(extensionRoot, 'dist');
const outputDirectory = join(distributionRoot, channel);
const packageJson = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
const baseManifest = JSON.parse(
  await readFile(join(extensionRoot, 'config', 'manifest.base.json'), 'utf8')
);
const variantManifest = JSON.parse(
  await readFile(join(extensionRoot, 'config', `manifest.${channel}.json`), 'utf8')
);
const buildChannelContract = await readBuildChannelContract();

await mkdir(distributionRoot, { recursive: true });
for (const entry of await readdir(distributionRoot, { withFileTypes: true })) {
  if (entry.name === 'store' || entry.name === 'automation') continue;
  await rm(join(distributionRoot, entry.name), { recursive: true, force: true });
}
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const sharedBuildOptions = {
  absWorkingDir: extensionRoot,
  bundle: true,
  define: {
    __VOICE_VAC_CHANNEL__: JSON.stringify(channel)
  },
  entryNames: '[name]',
  outdir: outputDirectory,
  platform: 'browser',
  metafile: true,
  target: 'chrome116'
};
const moduleBuildResult = await build({
  ...sharedBuildOptions,
  entryPoints: {
    popup: 'src/popup.ts',
    'service-worker': `src/service-worker.${channel}.ts`,
    offscreen: 'src/offscreen.ts',
    'audio-worklet': 'src/audio-worklet.ts'
  },
  format: 'esm'
});
const contentTunnelBuildResult = await build({
  ...sharedBuildOptions,
  entryPoints: { 'content-tunnel': 'src/content-tunnel.ts' },
  format: 'iife'
});
const buildMetafile = {
  inputs: {
    ...moduleBuildResult.metafile.inputs,
    ...contentTunnelBuildResult.metafile.inputs
  },
  outputs: {
    ...moduleBuildResult.metafile.outputs,
    ...contentTunnelBuildResult.metafile.outputs
  }
};

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
  ['../../LICENSE', 'VACVOX_LICENSE.txt']
];

for (const [source, destination] of copies) {
  const target = join(outputDirectory, destination);
  await mkdir(dirname(target), { recursive: true });
  await cp(resolve(extensionRoot, source), target);
}

const forbiddenCapabilities = [
  /chrome\.debugger/u,
  /Runtime\.evaluate/u,
  /Input\.dispatchMouseEvent/u,
  /(["'])debugger\1/u
];
const sourceFiles = Object.keys(buildMetafile.inputs)
  .filter((path) => ['.js', '.mjs', '.ts'].includes(extname(path)))
  .map((path) => resolve(extensionRoot, path));
const builtJavaScriptFiles = await javaScriptFiles(outputDirectory);

if (channel === 'store') {
  if (manifest.permissions.includes('debugger')) {
    throw new Error('Store capability boundary violation in manifest.json: debugger');
  }

  await assertNoForbiddenCapabilities(sourceFiles, 'Store source');
  await assertNoForbiddenCapabilities(builtJavaScriptFiles, 'Store built');
} else if (!manifest.permissions.includes('debugger')) {
  throw new Error('Automation manifest must contain the debugger permission.');
} else if (buildChannelContract.automation.driverReady) {
  const workerPath = join(outputDirectory, 'service-worker.js');
  const worker = await readFile(workerPath, 'utf8');
  for (const required of ['chrome.debugger', 'Runtime.evaluate', 'Input.dispatchMouseEvent']) {
    if (!worker.includes(required)) {
      throw new Error(`Automation capability boundary violation in service-worker.js: missing ${required}`);
    }
  }
  await assertNoForbiddenCapabilities(
    automationNonWorkerSourceFiles(buildMetafile),
    'Automation non-worker source'
  );
  await assertNoForbiddenCapabilities(
    builtJavaScriptFiles.filter((path) => path !== workerPath),
    'Automation non-worker built'
  );
} else {
  await assertNoForbiddenCapabilities(sourceFiles, 'Automation placeholder source');
  await assertNoForbiddenCapabilities(builtJavaScriptFiles, 'Automation placeholder built');
}

async function assertNoForbiddenCapabilities(paths, boundary) {
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    for (const pattern of forbiddenCapabilities) {
      const match = source.match(pattern);
      if (match) {
        throw new Error(
          `${boundary} capability boundary violation in ${relative(extensionRoot, path)}: ${match[0]}`
        );
      }
    }
  }
}

async function javaScriptFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await javaScriptFiles(path));
    } else if (extname(entry.name) === '.js' || extname(entry.name) === '.mjs') {
      paths.push(path);
    }
  }
  return paths;
}

function automationNonWorkerSourceFiles(metafile) {
  const paths = new Set();
  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    if (outputPath.endsWith('/service-worker.js') || outputPath === 'service-worker.js') continue;
    for (const inputPath of Object.keys(output.inputs)) {
      if (['.js', '.mjs', '.ts'].includes(extname(inputPath))) {
        paths.add(resolve(extensionRoot, inputPath));
      }
    }
  }
  return [...paths];
}

async function readBuildChannelContract() {
  let value;
  try {
    value = JSON.parse(
      await readFile(join(extensionRoot, 'config', 'build-channels.json'), 'utf8')
    );
  } catch (error) {
    throw invalidBuildChannelContract(error instanceof Error ? error.message : 'unreadable JSON');
  }

  if (!hasExactKeys(value, ['automation', 'schemaVersion']) || value.schemaVersion !== 1) {
    throw invalidBuildChannelContract('expected only schemaVersion: 1 and automation');
  }
  if (!hasExactKeys(value.automation, ['driverReady'])
    || typeof value.automation.driverReady !== 'boolean') {
    throw invalidBuildChannelContract('automation.driverReady must be an exact boolean');
  }

  return value;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === [...expectedKeys].sort()[index]);
}

function invalidBuildChannelContract(reason) {
  return new Error(`Invalid Voice VAC build channel contract: ${reason}`);
}
