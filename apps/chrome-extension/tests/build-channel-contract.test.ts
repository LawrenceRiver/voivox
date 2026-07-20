import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(extensionRoot, '..', '..');
const temporaryRoots: string[] = [];

describe('build channel contract', () => {
  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  });

  it('builds Automation when the real debugger driver is present in its worker', async () => {
    const result = await buildAutomationWith({
      automation: { driverReady: true },
      schemaVersion: 1
    });

    expect(result.exitCode).toBe(0);
  });

  it.each([
    { automation: {}, schemaVersion: 1 },
    { automation: { driverReady: 'false' }, schemaVersion: 1 },
    { automation: { driverReady: false }, extra: true, schemaVersion: 1 }
  ])('fails closed for an invalid or incomplete contract: %o', async (contract) => {
    const result = await buildAutomationWith(contract);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Invalid Voice VAC build channel contract');
  });

  it('fails closed when the placeholder contract is used with the real driver', async () => {
    const result = await buildAutomationWith({
      automation: { driverReady: false },
      schemaVersion: 1
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('placeholder');
  });

  it('rejects capability bytes while the Automation driver is still a placeholder', async () => {
    const result = await buildAutomationWith({
      automation: { driverReady: false },
      schemaVersion: 1
    }, 'worker');

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('placeholder');
  });

  it('rejects capability bytes injected into a non-worker Automation entry', async () => {
    const result = await buildAutomationWith({
      automation: { driverReady: true },
      schemaVersion: 1
    }, 'popup');

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('popup');
  });

  it('does not let a ready worker legitimize capability bytes in popup', async () => {
    const result = await buildAutomationWith({
      automation: { driverReady: true },
      schemaVersion: 1
    }, 'worker-and-popup');

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('popup');
  });
});

async function buildAutomationWith(
  contract: unknown,
  injectCapabilityByte?: 'popup' | 'worker' | 'worker-and-popup'
): Promise<{ exitCode: number; stderr: string }> {
  const container = await mkdtemp(join(workspaceRoot, '.chrome-extension-contract-'));
  const temporaryRoot = join(container, 'chrome-extension');
  temporaryRoots.push(container);
  await cp(extensionRoot, temporaryRoot, {
    filter: (source) => !source.includes('/dist/') && !source.includes('/release/'),
    recursive: true
  });
  await writeFile(
    join(temporaryRoot, 'config', 'build-channels.json'),
    `${JSON.stringify(contract, null, 2)}\n`
  );
  if (injectCapabilityByte) {
    const entryPoints = injectCapabilityByte === 'worker-and-popup'
      ? ['service-worker.automation.ts', 'popup.ts']
      : [injectCapabilityByte === 'popup' ? 'popup.ts' : 'service-worker.automation.ts'];
    const capabilityBytes = injectCapabilityByte === 'worker-and-popup'
      ? 'chrome.debugger Runtime.evaluate Input.dispatchMouseEvent'
      : 'chrome.debugger';
    await Promise.all(entryPoints.map((entryPoint) => writeFile(
      join(temporaryRoot, 'src', entryPoint),
      `\nthrow new Error('${capabilityBytes}');\n`,
      { flag: 'a' }
    )));
  }

  try {
    await execFileAsync(process.execPath, ['scripts/build.mjs', 'automation'], {
      cwd: temporaryRoot,
      env: { ...process.env, NO_COLOR: '1' }
    });
    return { exitCode: 0, stderr: '' };
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { exitCode: failure.code ?? 1, stderr: failure.stderr ?? '' };
  }
}
