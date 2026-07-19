#!/usr/bin/env node

import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const resourcesDirectory = resolve(repositoryRoot, 'apps/desktop/dist/resources');
const expectedPrefix = `${resolve(repositoryRoot, 'apps/desktop/dist')}/`;

if (!resourcesDirectory.startsWith(expectedPrefix) || resourcesDirectory === resolve(repositoryRoot, 'apps/desktop/dist')) {
  throw new Error('Refusing to clean an unexpected desktop resources path.');
}

await rm(resourcesDirectory, { force: true, recursive: true });
await mkdir(resourcesDirectory, { recursive: true });
