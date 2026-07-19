import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { collectPreflight, parsePreflightArguments } from './preflight.mjs';

const runProcess = promisify(execFile);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function validOutputs(overrides = {}) {
  return {
    'git rev-parse HEAD': `${COMMIT}\n`,
    'git symbolic-ref --quiet --short HEAD': 'codex/voice-vac-native\n',
    'git status --porcelain': '',
    'uname -m': 'arm64\n',
    'sysctl -n machdep.cpu.brand_string': 'Apple M4 Max\n',
    'sysctl -n hw.memsize': '68719476736\n',
    'sw_vers -productVersion': '26.5.2\n',
    'xcodebuild -version': 'Xcode 26.6\nBuild version 17F113\n',
    'swift --version': 'Apple Swift version 6.3.3 (swiftlang-6.3.3.1.3)\n',
    'blender --version': 'Blender 5.2.0 LTS\n',
    'chrome --version': 'Google Chrome 150.0.7871.125\n',
    'node --version': 'v25.8.2\n',
    'npm --version': '11.11.1\n',
    'python --version': 'Python 3.12.13\n',
    'ffmpeg -version': 'ffmpeg version 8.1.1 Copyright (c) 2000-2026\n',
    ...overrides
  };
}

function fixtureRunner(overrides = {}) {
  const outputs = validOutputs(overrides);
  return async (command, args = []) => {
    const key = `${basename(command)} ${args.join(' ')}`.trim();
    if (!(key in outputs)) throw new Error(`Command not found in fixture: ${key}`);
    const output = outputs[key];
    if (output instanceof Error) throw output;
    return output;
  };
}

test('collects the stable release preflight evidence shape', async () => {
  const evidence = await collectPreflight({
    now: () => new Date('2026-07-20T01:02:03.000Z'),
    runCommand: fixtureRunner(),
    commands: { chrome: 'chrome', python: 'python' }
  });

  assert.deepEqual(evidence, {
    schemaVersion: 1,
    recordedAt: '2026-07-20T01:02:03.000Z',
    git: {
      commit: COMMIT,
      branch: 'codex/voice-vac-native',
      clean: true
    },
    machine: {
      architecture: 'arm64',
      cpu: 'Apple M4 Max',
      memoryBytes: 68719476736
    },
    software: {
      macOS: '26.5.2',
      xcode: '26.6',
      swift: '6.3.3',
      blender: '5.2.0',
      chrome: '150.0.7871.125',
      node: '25.8.2',
      npm: '11.11.1',
      python: '3.12.13',
      ffmpeg: '8.1.1'
    }
  });
});

test('rejects unsupported hardware and release tool versions', async () => {
  const cases = [
    ['uname -m', 'x86_64\n', /arm64/],
    ['sw_vers -productVersion', '25.9\n', /macOS 26/],
    ['xcodebuild -version', 'Xcode 25.4\nBuild version 1\n', /Xcode 26/],
    ['swift --version', 'Apple Swift version 5.10\n', /Swift 6\.3/],
    ['blender --version', 'Blender 5.1.9\n', /Blender 5\.2/],
    ['chrome --version', 'Google Chrome 115.0.0.0\n', /Chrome 116/],
    ['node --version', 'v21.9.0\n', /Node\.js 22/],
    ['npm --version', '9.9.0\n', /npm 10/],
    ['python --version', 'Python 3.13.4\n', /Python 3\.12/]
  ];

  for (const [command, output, message] of cases) {
    await assert.rejects(
      collectPreflight({
        runCommand: fixtureRunner({ [command]: output }),
        commands: { chrome: 'chrome', python: 'python' }
      }),
      message,
      command
    );
  }
});

test('rejects missing tools, a dirty tree, and the wrong branch', async () => {
  await assert.rejects(
    collectPreflight({
      runCommand: fixtureRunner({ 'ffmpeg -version': new Error('ENOENT') }),
      commands: { chrome: 'chrome', python: 'python' }
    }),
    /missing required tool.*ffmpeg/i
  );
  await assert.rejects(
    collectPreflight({
      runCommand: fixtureRunner({ 'git status --porcelain': ' M package.json\n' }),
      commands: { chrome: 'chrome', python: 'python' }
    }),
    /clean worktree/i
  );
  await assert.rejects(
    collectPreflight({
      runCommand: fixtureRunner({
        'git symbolic-ref --quiet --short HEAD': 'feature/not-release\n'
      }),
      commands: { chrome: 'chrome', python: 'python' }
    }),
    /codex\/voice-vac-native/
  );
});

test('allows only the exact expected commit for a clean detached worktree', async () => {
  const detachedRunner = fixtureRunner({
    'git symbolic-ref --quiet --short HEAD': ''
  });
  const evidence = await collectPreflight({
    expectedCommit: COMMIT,
    runCommand: detachedRunner,
    commands: { chrome: 'chrome', python: 'python' }
  });
  assert.equal(evidence.git.branch, null);

  await assert.rejects(
    collectPreflight({
      runCommand: detachedRunner,
      commands: { chrome: 'chrome', python: 'python' }
    }),
    /detached.*--expected-commit/i
  );
  await assert.rejects(
    collectPreflight({
      expectedCommit: 'ffffffffffffffffffffffffffffffffffffffff',
      runCommand: detachedRunner,
      commands: { chrome: 'chrome', python: 'python' }
    }),
    /expected commit.*does not match/i
  );
});

test('parses only explicit preflight output and detached-worktree options', () => {
  assert.deepEqual(parsePreflightArguments([
    '--json-output', '/tmp/environment.json',
    '--expected-commit', COMMIT
  ]), {
    expectedCommit: COMMIT,
    jsonOutput: '/tmp/environment.json'
  });
  assert.deepEqual(parsePreflightArguments([]), {
    expectedCommit: undefined,
    jsonOutput: undefined
  });
  assert.throws(() => parsePreflightArguments(['--json-output']), /requires a value/);
  assert.throws(() => parsePreflightArguments(['--unknown', 'x']), /unknown option/i);
  assert.throws(
    () => parsePreflightArguments(['--expected-commit', 'not-a-commit']),
    /40-hex/
  );
});

test('CLI writes JSON only to an explicitly supplied temporary output', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-vac-preflight-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const binDirectory = join(directory, 'bin');
  await (await import('node:fs/promises')).mkdir(binDirectory, { recursive: true });

  const commandBodies = {
    git: `case "$1 $2 $3" in\n  "rev-parse HEAD ") echo '${COMMIT}' ;;\n  "symbolic-ref --quiet --short") echo 'codex/voice-vac-native' ;;\n  "status --porcelain ") : ;;\nesac`,
    uname: "echo 'arm64'",
    sysctl: `if [ "$2" = "hw.memsize" ]; then echo '68719476736'; else echo 'Apple M4 Max'; fi`,
    sw_vers: "echo '26.5.2'",
    xcodebuild: "printf 'Xcode 26.6\\nBuild version 17F113\\n'",
    swift: "echo 'Apple Swift version 6.3.3 (swiftlang-6.3.3.1.3)'",
    blender: "echo 'Blender 5.2.0 LTS'",
    chrome: "echo 'Google Chrome 150.0.7871.125'",
    node: "echo 'v25.8.2'",
    npm: "echo '11.11.1'",
    python: "echo 'Python 3.12.13'",
    ffmpeg: "echo 'ffmpeg version 8.1.1 Copyright'"
  };
  for (const [name, body] of Object.entries(commandBodies)) {
    const path = join(binDirectory, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
    await chmod(path, 0o755);
  }

  const cliPath = fileURLToPath(new URL('./preflight.mjs', import.meta.url));
  const jsonOutput = join(directory, 'evidence', 'environment.json');
  const environment = {
    ...process.env,
    PATH: `${binDirectory}:/usr/bin:/bin`,
    VOICE_VAC_CHROME_COMMAND: join(binDirectory, 'chrome'),
    VOICE_VAC_PYTHON_COMMAND: join(binDirectory, 'python')
  };
  await runProcess(process.execPath, [cliPath, '--json-output', jsonOutput], {
    cwd: directory,
    env: environment
  });
  const evidence = JSON.parse(await readFile(jsonOutput, 'utf8'));
  assert.equal(evidence.git.commit, COMMIT);
  assert.equal(evidence.software.python, '3.12.13');

  const noOutputDirectory = join(directory, 'no-output');
  await (await import('node:fs/promises')).mkdir(noOutputDirectory);
  await runProcess(process.execPath, [cliPath], {
    cwd: noOutputDirectory,
    env: environment
  });
  assert.deepEqual(await readdir(noOutputDirectory), []);
});
