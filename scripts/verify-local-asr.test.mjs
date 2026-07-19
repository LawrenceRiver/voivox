import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  QWEN_MODEL,
  buildEvidence,
  formatEvidenceMarkdown,
  parseVerificationArguments,
  parseWorkerProtocol
} from './verify-local-asr-lib.mjs';

const run = promisify(execFile);

test('pins the official local Qwen3-ASR snapshot and Python package', () => {
  assert.deepEqual(QWEN_MODEL, {
    id: 'Qwen/Qwen3-ASR-0.6B',
    revision: '5eb144179a02acc5e5ba31e748d22b0cf3e303b0',
    runtimePackage: 'qwen-asr',
    runtimeVersion: '0.0.6'
  });
});

test('parses a reproducible local-worker verification command', () => {
  assert.deepEqual(parseVerificationArguments([
    '--input', '/tmp/video.mp4',
    '--audio-output', '/tmp/segment.wav',
    '--json-output', 'docs/evidence/result.json',
    '--markdown-output', 'docs/evidence/result.md',
    '--model-path', '/models/Qwen3-ASR-0.6B',
    '--python-command', '/runtime/bin/python',
    '--start', '2.5',
    '--duration', '15',
    '--source-title', 'Voice VAC demo',
    '--source-url', 'https://example.test/video'
  ]), {
    audioOutput: '/tmp/segment.wav',
    durationSeconds: 15,
    input: '/tmp/video.mp4',
    jsonOutput: 'docs/evidence/result.json',
    markdownOutput: 'docs/evidence/result.md',
    modelPath: '/models/Qwen3-ASR-0.6B',
    pythonCommand: '/runtime/bin/python',
    sourceTitle: 'Voice VAC demo',
    sourceUrl: 'https://example.test/video',
    startSeconds: 2.5
  });
  assert.throws(() => parseVerificationArguments(['--duration', '0']), /positive number/);
  assert.throws(() => parseVerificationArguments(['--mode', 'fast']), /Unknown option/);
});

test('accepts only an ordered ready/accepted/result worker transcript', () => {
  assert.deepEqual(parseWorkerProtocol([
    '{"type":"status","status":"booting"}',
    '{"type":"status","status":"model_loading"}',
    '{"type":"ready","model_id":"Qwen/Qwen3-ASR-0.6B","model_revision":"5eb144179a02acc5e5ba31e748d22b0cf3e303b0","device":"mps","python_version":"3.12.9","runtime_package":"qwen-asr","runtime_version":"0.0.6","speech_api_used":false,"offline":true}',
    '{"type":"accepted","id":"verify_1"}',
    '{"type":"result","id":"verify_1","text":"hello","language":"English"}'
  ], 'verify_1'), {
    device: 'mps',
    language: 'English',
    modelRevision: QWEN_MODEL.revision,
    pythonVersion: '3.12.9',
    runtimePackage: 'qwen-asr',
    runtimeVersion: '0.0.6',
    speechApiUsed: false,
    text: 'hello'
  });
  assert.throws(() => parseWorkerProtocol(['third-party noise'], 'verify_1'), /invalid NDJSON/);
});

test('builds honest Qwen local-inference evidence', () => {
  const evidence = buildEvidence({
    audioSha256: 'audio-hash',
    audioSizeBytes: 480078,
    device: 'mps',
    durationSeconds: 15,
    inferenceSeconds: 3.4567,
    inputSha256: 'video-hash',
    inputSizeBytes: 123456,
    language: 'Chinese',
    modelLoadSeconds: 4.5678,
    modelPath: '/models/Qwen3-ASR-0.6B',
    runtime: {
      modelRevision: QWEN_MODEL.revision,
      pythonVersion: '3.12.9',
      runtimePackage: 'qwen-asr',
      runtimeVersion: '0.0.6',
      speechApiUsed: false
    },
    outputText: '你好 Voice VAC',
    recordedAt: '2026-07-19T00:00:00.000Z',
    sourceTitle: 'Demo',
    sourceUrl: 'https://example.test/video',
    startSeconds: 0,
    totalVerificationSeconds: 8.5
  });

  assert.equal(evidence.model.id, QWEN_MODEL.id);
  assert.equal(evidence.model.revision, QWEN_MODEL.revision);
  assert.equal(evidence.execution.device, 'mps');
  assert.equal(evidence.execution.speechApiUsed, false);
  assert.equal(evidence.execution.pythonVersion, '3.12.9');
  assert.equal(evidence.execution.runtimePackageVersion, '0.0.6');
  assert.equal(evidence.execution.modelLoadSeconds, 4.568);
  assert.equal(evidence.execution.inferenceSeconds, 3.457);
  assert.equal(evidence.result.text, '你好 Voice VAC');
  const markdown = formatEvidenceMarkdown(evidence);
  assert.match(markdown, /Qwen\/Qwen3-ASR-0\.6B/);
  assert.match(markdown, /No speech API was used/);
  assert.match(markdown, /mps/);
});

test('verification sources contain no Whisper or browser inference runtime', async () => {
  const sources = await Promise.all([
    readFile(new URL('./verify-local-asr.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./verify-local-asr-lib.mjs', import.meta.url), 'utf8')
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /whisper/iu);
    assert.doesNotMatch(source, /@huggingface\/transformers/iu);
    assert.doesNotMatch(source, /allowRemoteModels/iu);
  }
});

test('installer pins Python 3.12, qwen-asr, model revision, and an external manifest', async () => {
  const [requirements, installer, downloader] = await Promise.all([
    readFile(new URL('../native/asr/requirements.txt', import.meta.url), 'utf8'),
    readFile(new URL('./install-asr-runtime.sh', import.meta.url), 'utf8'),
    readFile(new URL('./download-qwen-model.py', import.meta.url), 'utf8')
  ]);
  assert.equal(requirements.trim(), 'qwen-asr==0.0.6');
  assert.match(installer, /python3\.12/);
  assert.match(installer, /requirements\.txt/);
  assert.match(installer, /download-qwen-model\.py/);
  assert.match(downloader, /snapshot_download/);
  assert.match(downloader, new RegExp(QWEN_MODEL.revision));
  assert.match(downloader, /model-manifest\.json/);
  assert.match(downloader, /configSha256/);
  assert.match(downloader, /os\.replace/);
});

test('executes the real verification CLI through FFmpeg and a clean worker exit', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-vac-verify-'));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const binDirectory = join(directory, 'bin');
  const modelPath = join(directory, 'model');
  await mkdir(binDirectory, { recursive: true });
  await mkdir(modelPath, { recursive: true });

  const configText = '{}';
  const configSha256 = (await import('node:crypto')).createHash('sha256').update(configText).digest('hex');
  await writeFile(join(modelPath, 'config.json'), configText, 'utf8');
  await writeFile(join(modelPath, 'model-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    repoId: QWEN_MODEL.id,
    revision: QWEN_MODEL.revision,
    modelPath,
    configSha256,
    installedAt: '2026-07-19T00:00:00.000Z'
  }), 'utf8');

  const inputPath = join(directory, 'input.mp4');
  const audioPath = join(directory, 'segment.wav');
  const jsonPath = join(directory, 'evidence.json');
  const markdownPath = join(directory, 'evidence.md');
  await writeFile(inputPath, 'fixture video bytes', 'utf8');

  const fakeFfmpeg = join(binDirectory, 'ffmpeg');
  await writeFile(fakeFfmpeg, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.at(-1) === 'pipe:1') process.stdout.write(Buffer.alloc(32000));
else fs.writeFileSync(args.at(-1), Buffer.from('fixture wav'));
`, 'utf8');
  await chmod(fakeFfmpeg, 0o755);

  const fakePython = join(binDirectory, 'voice-vac-python');
  await writeFile(fakePython, `#!/usr/bin/env node
const readline = require('node:readline');
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
emit({type:'status',status:'booting'});
emit({type:'status',status:'model_loading'});
emit({type:'ready',model_id:'${QWEN_MODEL.id}',model_revision:'${QWEN_MODEL.revision}',device:'cpu',python_version:'3.12.9',runtime_package:'qwen-asr',runtime_version:'0.0.6',speech_api_used:false,offline:true});
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const request = JSON.parse(line);
  emit({type:'accepted',id:request.id});
  emit({type:'result',id:request.id,text:'真实 CLI 通路。',language:'Chinese'});
});
`, 'utf8');
  await chmod(fakePython, 0o755);

  await run(process.execPath, [fileURLToPath(new URL('./verify-local-asr.mjs', import.meta.url)),
    '--input', inputPath,
    '--audio-output', audioPath,
    '--json-output', jsonPath,
    '--markdown-output', markdownPath,
    '--model-path', modelPath,
    '--python-command', fakePython,
    '--duration', '1',
    '--source-title', 'Fixture',
    '--source-url', 'https://example.test/video'
  ], { env: { ...process.env, PATH: `${binDirectory}:${process.env.PATH ?? ''}` } });

  const evidence = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(evidence.result.text, '真实 CLI 通路。');
  assert.equal(evidence.execution.pythonVersion, '3.12.9');
  assert.equal(evidence.execution.runtimePackageVersion, '0.0.6');
  assert.equal(evidence.execution.speechApiUsed, false);
  assert.match(await readFile(markdownPath, 'utf8'), /No speech API was used/);
});
