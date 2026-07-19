import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MacProcessTapHost } from '../src/main/mac-process-tap-host.js';

const stubbornHostPath = fileURLToPath(new URL('./fixtures/stubborn-process-host.cjs', import.meta.url));
const TEST_FIXTURE_START_TIMEOUT_MS = 2_500;

function createHost(startTimeoutMs = 25): MacProcessTapHost {
  return new MacProcessTapHost(stubbornHostPath, {
    commandTimeoutMs: 25,
    startTimeoutMs,
    terminationGraceMs: 25
  });
}

async function boundedOutcome(operation: Promise<unknown>): Promise<string> {
  return Promise.race([
    operation.then(
      () => 'settled',
      (error: unknown) => error instanceof Error ? error.message : String(error)
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 250))
  ]);
}

describe('MacProcessTapHost process bounds', () => {
  it('times out and force-terminates a process-list helper that never answers', async () => {
    const outcome = await boundedOutcome(createHost().listProcesses());

    expect(outcome).toBe('Voice Vac process host did not list apps within 25 ms.');
  });

  it('force-terminates failed startup cleanup instead of awaiting the helper forever', async () => {
    const host = createHost();
    const outcome = await boundedOutcome(host.start('never-started', 41));

    expect(outcome).toBe('Voice Vac process host did not start within 25 ms.');
    await expect(host.discardAll()).resolves.toBeUndefined();
  });

  it('keeps a recording tracked until a bounded stop has terminated its helper', async () => {
    const host = createHost(TEST_FIXTURE_START_TIMEOUT_MS);
    await host.start('active-recording', 42);

    const outcome = await boundedOutcome(host.stop('active-recording'));

    expect(outcome).not.toBe('still pending');
    await expect(host.discardAll()).resolves.toBeUndefined();
  });
});
