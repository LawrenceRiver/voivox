import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipSync, zipSync } from 'fflate';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const channel = process.argv[2];
// ZIP stores a timezone-free DOS timestamp. A local constructor keeps the
// encoded fields identical in every CI timezone and avoids a 1979 underflow.
const stableTimestamp = new Date(1980, 0, 1, 0, 0, 0);

if (channel !== 'store' && channel !== 'automation') {
  throw new Error('Usage: node scripts/package.mjs <store|automation>');
}

const packageJson = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
const label = channel === 'store' ? 'Store' : 'Automation';
const releaseDirectory = join(extensionRoot, 'release');
const archive = join(releaseDirectory, `Voice-VAC-${label}-${packageJson.version}.zip`);
const temporaryArchive = `${archive}.tmp-${process.pid}`;
const distributionDirectory = join(extensionRoot, 'dist', channel);

await import('./build.mjs');
await mkdir(releaseDirectory, { recursive: true });

const files = await collectFiles(distributionDirectory);
const entries = Object.fromEntries(await Promise.all(files.map(async (relativePath) => {
  const contents = new Uint8Array(await readFile(join(distributionDirectory, relativePath)));
  const alreadyCompressed = /\.(?:png|wasm)$/u.test(relativePath);
  return [relativePath, [contents, {
    attrs: 0o644 << 16,
    level: alreadyCompressed ? 0 : 9,
    mtime: stableTimestamp,
    os: 3
  }]];
})));

const archiveBytes = zipSync(entries, {
  attrs: 0o644 << 16,
  level: 9,
  mtime: stableTimestamp,
  os: 3
});
const unpacked = unzipSync(archiveBytes);
if (!unpacked['manifest.json'] || !unpacked['service-worker.js']) {
  throw new Error(`Voice VAC ${channel} archive is missing required runtime files.`);
}

try {
  await writeFile(temporaryArchive, archiveBytes, { flag: 'wx' });
  await replaceArchive(temporaryArchive, archive);
} finally {
  await rm(temporaryArchive, { force: true });
}

async function replaceArchive(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (!error || typeof error !== 'object' || !['EEXIST', 'EPERM'].includes(error.code)) {
      throw error;
    }
    await rm(destination, { force: true });
    await rename(source, destination);
  }
}

async function collectFiles(directory, prefix = '') {
  const children = await readdir(join(directory, prefix), { withFileTypes: true });
  children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const files = [];
  for (const child of children) {
    const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
    if (child.isDirectory()) {
      files.push(...await collectFiles(directory, relativePath));
    } else if (child.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}
