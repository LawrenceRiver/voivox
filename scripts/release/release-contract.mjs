import { basename } from 'node:path';

const VERSION = '0.2.0';
const STORE_PERMISSIONS = [
  'activeTab',
  'nativeMessaging',
  'offscreen',
  'scripting',
  'storage',
  'tabCapture'
];
const AUTOMATION_PERMISSIONS = [
  'activeTab',
  'debugger',
  'nativeMessaging',
  'offscreen',
  'scripting',
  'storage',
  'tabCapture'
];
const ARTIFACTS = [
  `Voice-VAC-${VERSION}-arm64.dmg`,
  `Voice-VAC-Store-Extension-${VERSION}.zip`,
  `Voice-VAC-Automation-Extension-${VERSION}.zip`
];

export const RELEASE_CONTRACT = deepFreeze({
  productName: 'Voice VAC',
  version: VERSION,
  tag: `v${VERSION}`,
  bundleID: 'io.voivox.app',
  model: 'Qwen/Qwen3-ASR-0.6B',
  hoseJointCount: 64,
  releaseDirectory: 'dist/release',
  evidenceDirectory: `docs/evidence/release-${VERSION}`,
  checksumFile: 'SHA256SUMS.txt',
  artifacts: ARTIFACTS,
  extensions: {
    store: {
      id: 'pepfpbobjbjehhhcjiokmneclohlffno',
      permissions: STORE_PERMISSIONS
    },
    automation: {
      id: 'ciijinidnlbokpbeiabifcnoighmbnmh',
      permissions: AUTOMATION_PERMISSIONS
    }
  }
});

export function assertReleaseContract(contract) {
  if (!contract || typeof contract !== 'object') {
    throw new TypeError('Release contract must be an object.');
  }
  if (contract.productName !== 'Voice VAC') {
    throw new Error('Release product name must be exactly Voice VAC.');
  }
  if (contract.version !== VERSION || contract.tag !== `v${contract.version}`) {
    throw new Error(`Release version and tag must remain ${VERSION} and v${VERSION}.`);
  }
  if (contract.releaseDirectory !== 'dist/release') {
    throw new Error('Release artifacts must stay inside dist/release.');
  }
  if (contract.evidenceDirectory !== `docs/evidence/release-${VERSION}`) {
    throw new Error(`Release evidence must stay under docs/evidence/release-${VERSION}.`);
  }
  if (contract.hoseJointCount !== 64) {
    throw new Error('Voice VAC release assets require exactly 64 hose joints.');
  }
  if (!Array.isArray(contract.artifacts)) {
    throw new TypeError('Release artifacts must be an array.');
  }
  if (new Set(contract.artifacts).size !== contract.artifacts.length) {
    throw new Error('Release contract contains a duplicate artifact name.');
  }
  for (const artifact of contract.artifacts) {
    if (typeof artifact !== 'string' || basename(artifact) !== artifact) {
      throw new Error('Every release artifact must be a basename inside dist/release.');
    }
    if (!artifact.includes(`-${contract.version}`)) {
      throw new Error(`Release artifact version must match ${contract.version}: ${artifact}`);
    }
  }
  if (!sameStrings(contract.artifacts, ARTIFACTS)) {
    throw new Error(`Release artifacts must be exactly: ${ARTIFACTS.join(', ')}.`);
  }

  const store = contract.extensions?.store;
  const automation = contract.extensions?.automation;
  if (!store || !automation) throw new Error('Both Store and Automation extensions are required.');
  if (store.id === automation.id) {
    throw new Error('Store and Automation Extension IDs must differ.');
  }
  if (store.id !== 'pepfpbobjbjehhhcjiokmneclohlffno') {
    throw new Error('Store Extension ID does not match the release identity.');
  }
  if (automation.id !== 'ciijinidnlbokpbeiabifcnoighmbnmh') {
    throw new Error('Automation Extension ID does not match the release identity.');
  }
  if (!sameStrings(store.permissions, STORE_PERMISSIONS)) {
    if (store.permissions?.includes('debugger')) {
      throw new Error('Store Extension permissions must never include debugger.');
    }
    throw new Error('Store Extension permissions do not match the release contract.');
  }
  if (!sameStrings(automation.permissions, AUTOMATION_PERMISSIONS)) {
    throw new Error('Automation Extension permissions do not match the release contract.');
  }
}

function sameStrings(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

assertReleaseContract(RELEASE_CONTRACT);
