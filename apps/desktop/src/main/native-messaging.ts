import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import type { LocalAsrStatus } from '@voivox/core';

export const NATIVE_MESSAGING_HOST_NAME = 'com.voivox.bridge';
export const VOIVOX_STORE_EXTENSION_ORIGIN = 'chrome-extension://pepfpbobjbjehhhcjiokmneclohlffno/';
export const VOIVOX_AUTOMATION_EXTENSION_ORIGIN = 'chrome-extension://ciijinidnlbokpbeiabifcnoighmbnmh/';
export const VOIVOX_NATIVE_EXTENSION_ORIGINS = [
  VOIVOX_STORE_EXTENSION_ORIGIN,
  VOIVOX_AUTOMATION_EXTENSION_ORIGIN
] as const;

const NATIVE_MESSAGING_DIRECTORIES = [
  'Library/Application Support/Google/Chrome/NativeMessagingHosts',
  'Library/Application Support/Google/Chrome Beta/NativeMessagingHosts',
  'Library/Application Support/Chromium/NativeMessagingHosts'
] as const;

export type ExtensionConnectionPublisher = {
  filePath: string;
  invalidate: () => Promise<void>;
  publish: (localAsr: LocalAsrStatus) => Promise<void>;
};

export type NativeMessagingHostInstallation = {
  failed: Array<{ path: string; reason: string }>;
  installed: string[];
};

export function createExtensionConnectionPublisher(options: {
  baseUrl: string;
  dataPath: string;
  extensionToken: string;
}): ExtensionConnectionPublisher {
  const filePath = join(options.dataPath, 'extension-connection.json');
  let active = true;
  let queue = Promise.resolve();

  const publish = (localAsr: LocalAsrStatus): Promise<void> => {
    if (!active) {
      return queue;
    }

    const result = queue.then(async () => {
      if (!active) {
        return;
      }
      await writeAtomicJson(filePath, {
        baseUrl: options.baseUrl,
        capabilities: { localAsr },
        service: 'voivox',
        status: 'ready',
        token: options.extensionToken
      });
    });
    queue = result.catch(() => undefined);
    return result;
  };

  return {
    filePath,
    publish,
    invalidate: async () => {
      active = false;
      await queue;
      await rm(filePath, { force: true });
    }
  };
}

export async function installNativeMessagingHost(options: {
  executablePath: string;
  homeDirectory?: string;
  writeManifest?: (manifestPath: string, manifest: unknown) => Promise<void>;
}): Promise<NativeMessagingHostInstallation> {
  if (!isAbsolute(options.executablePath)) {
    throw new Error('The Voice Vac native messaging host path must be absolute.');
  }

  const manifest = {
    allowed_origins: [...VOIVOX_NATIVE_EXTENSION_ORIGINS],
    description: 'Voice Vac local desktop discovery bridge',
    name: NATIVE_MESSAGING_HOST_NAME,
    path: options.executablePath,
    type: 'stdio'
  };
  const homeDirectory = options.homeDirectory ?? homedir();
  const manifestPaths = NATIVE_MESSAGING_DIRECTORIES.map((directory) =>
    join(homeDirectory, directory, `${NATIVE_MESSAGING_HOST_NAME}.json`)
  );

  const writeManifest = options.writeManifest ?? writeAtomicJson;
  const attempts = await Promise.all(manifestPaths.map(async (manifestPath) => {
    try {
      await writeManifest(manifestPath, manifest);
      return { path: manifestPath, success: true as const };
    } catch (error) {
      return {
        path: manifestPath,
        reason: error instanceof Error ? error.message : 'Unknown manifest write failure.',
        success: false as const
      };
    }
  }));
  return {
    failed: attempts
      .filter((attempt) => !attempt.success)
      .map((attempt) => ({ path: attempt.path, reason: attempt.reason })),
    installed: attempts
      .filter((attempt) => attempt.success)
      .map((attempt) => attempt.path)
  };
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
