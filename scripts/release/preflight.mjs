import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { RELEASE_CONTRACT, assertReleaseContract } from './release-contract.mjs';

const executeFile = promisify(execFile);
const RELEASE_BRANCH = 'codex/voice-vac-native';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/iu;

export async function collectPreflight({
  commands: commandOverrides = {},
  expectedCommit,
  now = () => new Date(),
  runCommand = defaultRunCommand
} = {}) {
  assertReleaseContract(RELEASE_CONTRACT);
  if (expectedCommit !== undefined && !COMMIT_PATTERN.test(expectedCommit)) {
    throw new Error('--expected-commit must be a 40-hex Git commit.');
  }

  const commands = { ...defaultCommands(), ...commandOverrides };
  const required = async (label, command, args) => {
    try {
      return cleanOutput(await runCommand(command, args));
    } catch (error) {
      throw new Error(`Missing required tool or failed probe: ${label}. ${errorMessage(error)}`);
    }
  };

  const commit = (await required('git', commands.git, ['rev-parse', 'HEAD'])).toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) throw new Error('Git HEAD must resolve to a 40-hex commit.');
  let branch = null;
  try {
    branch = cleanOutput(await runCommand(commands.git, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) || null;
  } catch (error) {
    if (!isDetachedHeadError(error)) {
      throw new Error(`Missing required tool or failed probe: git. ${errorMessage(error)}`);
    }
  }
  const worktreeStatus = await required('git', commands.git, ['status', '--porcelain']);
  if (worktreeStatus !== '') {
    throw new Error('Release preflight requires a clean worktree.');
  }
  assertReleaseGitState({ branch, commit, expectedCommit });

  const [
    architecture,
    cpu,
    memoryText,
    macOSText,
    xcodeText,
    swiftText,
    blenderText,
    chromeText,
    nodeText,
    npmText,
    pythonText,
    ffmpegText
  ] = await Promise.all([
    required('uname', commands.uname, ['-m']),
    required('sysctl', commands.sysctl, ['-n', 'machdep.cpu.brand_string']),
    required('sysctl', commands.sysctl, ['-n', 'hw.memsize']),
    required('sw_vers', commands.swVers, ['-productVersion']),
    required('xcodebuild', commands.xcodebuild, ['-version']),
    required('swift', commands.swift, ['--version']),
    required('blender', commands.blender, ['--version']),
    required('chrome', commands.chrome, ['--version']),
    required('node', commands.node, ['--version']),
    required('npm', commands.npm, ['--version']),
    required('python', commands.python, ['--version']),
    required('ffmpeg', commands.ffmpeg, ['-version'])
  ]);

  const memoryBytes = Number(memoryText);
  if (architecture !== 'arm64') throw new Error('Release machine architecture must be arm64.');
  if (!cpu) throw new Error('Release preflight could not identify the CPU.');
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
    throw new Error('Release preflight could not determine physical memory.');
  }

  const software = {
    macOS: captureVersion(macOSText, /^(\d+(?:\.\d+){1,3})/u, 'macOS'),
    xcode: captureVersion(xcodeText, /Xcode\s+(\d+(?:\.\d+){0,3})/u, 'Xcode'),
    swift: captureVersion(swiftText, /Apple Swift version\s+(\d+(?:\.\d+){1,3})/u, 'Swift'),
    blender: captureVersion(blenderText, /Blender\s+(\d+(?:\.\d+){1,3})/u, 'Blender'),
    chrome: captureVersion(chromeText, /(?:Google Chrome|Chromium)\s+(\d+(?:\.\d+){1,3})/u, 'Chrome'),
    node: captureVersion(nodeText, /v?(\d+(?:\.\d+){1,3})/u, 'Node.js'),
    npm: captureVersion(npmText, /^(\d+(?:\.\d+){1,3})/u, 'npm'),
    python: captureVersion(pythonText, /Python\s+(\d+(?:\.\d+){1,3})/u, 'Python'),
    ffmpeg: captureVersion(ffmpegText, /ffmpeg version\s+(\d+(?:\.\d+){1,3})/u, 'FFmpeg')
  };
  assertSupportedSoftware(software);

  const recordedAt = now().toISOString();
  return {
    schemaVersion: 1,
    recordedAt,
    git: { commit, branch, clean: true },
    machine: { architecture, cpu, memoryBytes },
    software
  };
}

export function parsePreflightArguments(argv) {
  if (argv.length % 2 !== 0) throw new Error(`Option ${argv.at(-1)} requires a value.`);
  const values = new Map();
  const supported = new Set(['--expected-commit', '--json-output']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!supported.has(name)) throw new Error(`Unknown option: ${name ?? '[missing]'}`);
    if (!value || value.startsWith('--')) throw new Error(`Option ${name} requires a value.`);
    if (values.has(name)) throw new Error(`Duplicate option: ${name}`);
    values.set(name, value);
  }

  const expectedCommit = values.get('--expected-commit');
  if (expectedCommit !== undefined && !COMMIT_PATTERN.test(expectedCommit)) {
    throw new Error('--expected-commit must be a 40-hex Git commit.');
  }
  return {
    expectedCommit,
    jsonOutput: values.get('--json-output')
  };
}

async function defaultRunCommand(command, args) {
  const { stdout, stderr } = await executeFile(command, args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024
  });
  return stdout || stderr;
}

function defaultCommands() {
  return {
    git: 'git',
    uname: 'uname',
    sysctl: 'sysctl',
    swVers: 'sw_vers',
    xcodebuild: 'xcodebuild',
    swift: 'swift',
    blender: process.env.VOICE_VAC_BLENDER_COMMAND || 'blender',
    chrome: process.env.VOICE_VAC_CHROME_COMMAND
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    node: 'node',
    npm: 'npm',
    python: process.env.VOICE_VAC_PYTHON_COMMAND || findLocalASRPython(),
    ffmpeg: 'ffmpeg'
  };
}

function findLocalASRPython() {
  const candidates = [
    join(homedir(), 'Library/Application Support/Voice VAC/asr-venv/bin/python'),
    join(homedir(), 'Library/Application Support/Voice Vac/asr-venv/bin/python'),
    '/opt/homebrew/bin/python3.12'
  ];
  return candidates.find((candidate) => existsSync(candidate)) || 'python3.12';
}

function assertReleaseGitState({ branch, commit, expectedCommit }) {
  if (branch === RELEASE_BRANCH) {
    if (expectedCommit && commit !== expectedCommit.toLowerCase()) {
      throw new Error(`Git HEAD ${commit} does not match expected commit ${expectedCommit}.`);
    }
    return;
  }
  if (branch !== null) {
    throw new Error(`Release preflight must run on branch ${RELEASE_BRANCH}.`);
  }
  if (!expectedCommit) {
    throw new Error('A detached release worktree requires --expected-commit <40-hex>.');
  }
  if (commit !== expectedCommit.toLowerCase()) {
    throw new Error(`Detached HEAD expected commit ${expectedCommit} does not match ${commit}.`);
  }
}

function assertSupportedSoftware(software) {
  requireAtLeast(software.macOS, [26, 0], 'macOS 26');
  requireAtLeast(software.xcode, [26, 0], 'Xcode 26');
  requireAtLeast(software.swift, [6, 3], 'Swift 6.3');
  if (!software.blender.startsWith('5.2.')) {
    throw new Error(`Blender 5.2.x LTS is required; found ${software.blender}.`);
  }
  requireAtLeast(software.chrome, [116, 0], 'Chrome 116');
  requireAtLeast(software.node, [22, 0], 'Node.js 22');
  requireAtLeast(software.npm, [10, 0], 'npm 10');
  if (!software.python.startsWith('3.12.')) {
    throw new Error(`Python 3.12.x is required for local Qwen ASR; found ${software.python}.`);
  }
}

function requireAtLeast(actual, expected, label) {
  const actualParts = actual.split('.').map(Number);
  for (let index = 0; index < expected.length; index += 1) {
    const actualPart = actualParts[index] ?? 0;
    if (actualPart > expected[index]) return;
    if (actualPart < expected[index]) {
      throw new Error(`${label} or later is required; found ${actual}.`);
    }
  }
}

function captureVersion(text, pattern, label) {
  const match = pattern.exec(text);
  if (!match) throw new Error(`Could not parse ${label} version from: ${text}`);
  return match[1];
}

function cleanOutput(output) {
  if (typeof output === 'string') return output.trim();
  if (output && typeof output.stdout === 'string') {
    return (output.stdout || output.stderr || '').trim();
  }
  throw new TypeError('Command runner must return command output as text.');
}

function isDetachedHeadError(error) {
  return error && typeof error === 'object' && error.code === 1;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function writeJSONAtomically(path, value) {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function main() {
  const options = parsePreflightArguments(process.argv.slice(2));
  const evidence = await collectPreflight({ expectedCommit: options.expectedCommit });
  if (options.jsonOutput) {
    await writeJSONAtomically(options.jsonOutput, evidence);
    process.stdout.write(`Voice VAC preflight passed; evidence written to ${options.jsonOutput}.\n`);
  } else {
    process.stdout.write(`Voice VAC preflight passed for ${evidence.git.commit}.\n`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
