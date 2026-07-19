import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

import { RELEASE_CONTRACT, assertReleaseContract } from './release-contract.mjs';

const run = promisify(execFile);
const RELEASE_HARNESS_PATHS = [
  'scripts/release/release-contract.mjs',
  'scripts/release/release-contract.test.mjs',
  'scripts/release/preflight.mjs',
  'scripts/release/preflight.test.mjs'
];

function mutableContract(overrides = {}) {
  return {
    ...structuredClone(RELEASE_CONTRACT),
    ...overrides
  };
}

test('release 0.2.0 has exactly one DMG and two extension ZIPs', () => {
  assert.deepEqual(RELEASE_CONTRACT.artifacts, [
    'Voice-VAC-0.2.0-arm64.dmg',
    'Voice-VAC-Store-Extension-0.2.0.zip',
    'Voice-VAC-Automation-Extension-0.2.0.zip'
  ]);
  assert.equal(RELEASE_CONTRACT.tag, 'v0.2.0');
  assert.doesNotThrow(() => assertReleaseContract(RELEASE_CONTRACT));
});

test('Store and Automation permission contracts cannot converge', () => {
  assert.deepEqual(RELEASE_CONTRACT.extensions.store.permissions, [
    'activeTab', 'nativeMessaging', 'offscreen', 'scripting', 'storage', 'tabCapture'
  ]);
  assert(!RELEASE_CONTRACT.extensions.store.permissions.includes('debugger'));
  assert(RELEASE_CONTRACT.extensions.automation.permissions.includes('debugger'));
  assert.notEqual(
    RELEASE_CONTRACT.extensions.store.id,
    RELEASE_CONTRACT.extensions.automation.id
  );
});

test('release contract is deeply immutable', () => {
  assert(Object.isFrozen(RELEASE_CONTRACT));
  assert(Object.isFrozen(RELEASE_CONTRACT.artifacts));
  assert(Object.isFrozen(RELEASE_CONTRACT.extensions));
  assert(Object.isFrozen(RELEASE_CONTRACT.extensions.store));
  assert(Object.isFrozen(RELEASE_CONTRACT.extensions.store.permissions));
  assert(Object.isFrozen(RELEASE_CONTRACT.extensions.automation));
  assert(Object.isFrozen(RELEASE_CONTRACT.extensions.automation.permissions));
});

test('rejects duplicate or out-of-directory artifact contracts', () => {
  const duplicate = mutableContract({
    artifacts: [
      'Voice-VAC-0.2.0-arm64.dmg',
      'Voice-VAC-0.2.0-arm64.dmg',
      'Voice-VAC-Automation-Extension-0.2.0.zip'
    ]
  });
  assert.throws(() => assertReleaseContract(duplicate), /duplicate artifact/i);
  assert.throws(
    () => assertReleaseContract(mutableContract({ releaseDirectory: 'dist' })),
    /dist\/release/
  );
  assert.throws(
    () => assertReleaseContract(mutableContract({
      artifacts: [
        '../Voice-VAC-0.2.0-arm64.dmg',
        'Voice-VAC-Store-Extension-0.2.0.zip',
        'Voice-VAC-Automation-Extension-0.2.0.zip'
      ]
    })),
    /artifact.*basename/i
  );
});

test('rejects release identity and version drift', () => {
  assert.throws(
    () => assertReleaseContract(mutableContract({ productName: 'VoiceVac' })),
    /product name/i
  );
  assert.throws(
    () => assertReleaseContract(mutableContract({ tag: 'v0.2.1' })),
    /version/i
  );
  assert.throws(
    () => assertReleaseContract(mutableContract({
      artifacts: [
        'Voice-VAC-0.2.1-arm64.dmg',
        'Voice-VAC-Store-Extension-0.2.0.zip',
        'Voice-VAC-Automation-Extension-0.2.0.zip'
      ]
    })),
    /artifact.*version/i
  );
});

test('rejects unsafe extension and hose contracts', () => {
  const storeDebugger = mutableContract();
  storeDebugger.extensions.store.permissions.push('debugger');
  assert.throws(() => assertReleaseContract(storeDebugger), /Store.*debugger/i);

  const equalIDs = mutableContract();
  equalIDs.extensions.automation.id = equalIDs.extensions.store.id;
  assert.throws(() => assertReleaseContract(equalIDs), /Extension IDs/i);

  assert.throws(
    () => assertReleaseContract(mutableContract({ hoseJointCount: 63 })),
    /64.*joint/i
  );
});

test('release harness sources are trackable in a clean checkout', async () => {
  await assert.rejects(
    run('git', ['check-ignore', '--no-index', '--', ...RELEASE_HARNESS_PATHS]),
    (error) => error?.code === 1,
    'release harness paths must not match an ignore rule'
  );
  await assert.doesNotReject(
    run('git', ['add', '--dry-run', '--', ...RELEASE_HARNESS_PATHS])
  );
});
