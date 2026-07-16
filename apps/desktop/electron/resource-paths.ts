import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type BundledResourceOptions = {
  isPackaged: boolean;
  moduleUrl: string;
  resourcesPath: string;
};

export function resolveElectronEntryPoints(moduleUrl: string): { preload: string; renderer: string } {
  return {
    preload: fileURLToPath(new URL('./preload.js', moduleUrl)),
    renderer: fileURLToPath(new URL('../renderer/index.html', moduleUrl))
  };
}

/**
 * Keep executable resources outside the application archive. Python needs a real
 * filesystem path for the worker, and macOS needs an executable path for the
 * Core Audio host. electron-builder copies them to Contents/Resources/voivox.
 */
export function resolveBundledResource(name: string, options: BundledResourceOptions): string {
  if (options.isPackaged) {
    return join(options.resourcesPath, 'voivox', name);
  }

  return fileURLToPath(new URL(`../resources/${name}`, options.moduleUrl));
}
