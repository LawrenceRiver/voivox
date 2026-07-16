import { constants } from 'node:fs';
import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createExtensionConnectionPublisher,
  installNativeMessagingHost,
  NATIVE_MESSAGING_HOST_NAME,
  VOIVOX_EXTENSION_ORIGIN
} from '../src/main/native-messaging.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true
  })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'voivox-native-messaging-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('extension connection publisher', () => {
  it('atomically publishes only the restricted extension connection with owner-only permissions', async () => {
    const dataPath = await temporaryDirectory();
    const publisher = createExtensionConnectionPublisher({
      baseUrl: 'http://127.0.0.1:43817',
      dataPath,
      extensionToken: 'restricted-extension-token'
    });

    await publisher.publish('checking');

    const filePath = join(dataPath, 'extension-connection.json');
    const raw = await readFile(filePath, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      baseUrl: 'http://127.0.0.1:43817',
      capabilities: { localAsr: 'checking' },
      service: 'voivox',
      status: 'ready',
      token: 'restricted-extension-token'
    });
    expect(raw).not.toContain('primary');
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await expect((await import('node:fs/promises')).readdir(dataPath)).resolves.toEqual([
      'extension-connection.json'
    ]);
  });

  it('updates local ASR readiness and cannot recreate the connection after invalidation', async () => {
    const dataPath = await temporaryDirectory();
    const publisher = createExtensionConnectionPublisher({
      baseUrl: 'http://127.0.0.1:43817',
      dataPath,
      extensionToken: 'restricted-extension-token'
    });

    await publisher.publish('checking');
    await publisher.publish('ready');
    expect(JSON.parse(await readFile(publisher.filePath, 'utf8'))).toMatchObject({
      capabilities: { localAsr: 'ready' }
    });

    await publisher.invalidate();
    await expect(access(publisher.filePath, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });

    await publisher.publish('missing');
    await expect(access(publisher.filePath, constants.F_OK)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Chrome native messaging host installation', () => {
  it('atomically installs exact-origin manifests with an absolute bundled executable path', async () => {
    const homeDirectory = await temporaryDirectory();
    const executablePath = join(homeDirectory, 'VOIVOX.app', 'Contents', 'Resources', 'voivox', 'voivox-native-host');

    const installation = await installNativeMessagingHost({ executablePath, homeDirectory });
    const manifestPaths = installation.installed;

    expect(manifestPaths).toEqual([
      join(homeDirectory, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.voivox.bridge.json'),
      join(homeDirectory, 'Library/Application Support/Google/Chrome Beta/NativeMessagingHosts/com.voivox.bridge.json'),
      join(homeDirectory, 'Library/Application Support/Chromium/NativeMessagingHosts/com.voivox.bridge.json')
    ]);
    for (const manifestPath of manifestPaths) {
      expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual({
        allowed_origins: [VOIVOX_EXTENSION_ORIGIN],
        description: 'VOIVOX local desktop discovery bridge',
        name: NATIVE_MESSAGING_HOST_NAME,
        path: executablePath,
        type: 'stdio'
      });
      expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    }
    expect(installation.failed).toEqual([]);
  });

  it('keeps installing other browsers and reports one manifest write failure', async () => {
    const homeDirectory = await temporaryDirectory();
    const executablePath = join(homeDirectory, 'voivox-native-host');
    const attempted: string[] = [];

    const installation = await installNativeMessagingHost({
      executablePath,
      homeDirectory,
      writeManifest: async (manifestPath) => {
        attempted.push(manifestPath);
        if (manifestPath.includes('Chrome Beta')) {
          throw new Error('simulated read-only directory');
        }
      }
    });

    expect(attempted).toHaveLength(3);
    expect(installation.installed).toHaveLength(2);
    expect(installation.failed).toEqual([{
      path: join(homeDirectory, 'Library/Application Support/Google/Chrome Beta/NativeMessagingHosts/com.voivox.bridge.json'),
      reason: 'simulated read-only directory'
    }]);
  });

  it('rejects relative native-host executable paths', async () => {
    await expect(installNativeMessagingHost({
      executablePath: 'dist/resources/voivox-native-host',
      homeDirectory: await temporaryDirectory()
    })).rejects.toThrow('absolute');
  });
});

describe('desktop native messaging build', () => {
  it('packages the native messaging executable beside the Core Audio host', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { scripts?: { build?: string } };

    expect(packageJson.scripts?.build).toContain(
      '../../native/macos/.build/release/voivox-native-host'
    );
    expect(packageJson.scripts?.build).toContain('dist/resources/');
  });
});
