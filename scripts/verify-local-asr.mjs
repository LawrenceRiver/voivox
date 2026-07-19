#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { env, pipeline } from '@huggingface/transformers';

import {
  FAST_MODEL,
  QUALITY_MODEL,
  assertFastModelPinMatches,
  assertQualityModelPinMatches,
  buildEvidence,
  decodeFloat32Le,
  formatEvidenceMarkdown,
  parseVerificationArguments
} from './verify-local-asr-lib.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

async function main() {
  const verificationStartedAt = performance.now();
  const options = parseVerificationArguments(process.argv.slice(2));
  const input = resolve(options.input);
  const audioOutput = resolve(options.audioOutput);
  const jsonOutput = resolve(options.jsonOutput);
  const markdownOutput = resolve(options.markdownOutput);
  const extensionModelSource = await readFile(
    resolve(repositoryRoot, 'apps/chrome-extension/src/local-transcription.ts'),
    'utf8'
  );
  const model = options.mode === 'quality' ? QUALITY_MODEL : FAST_MODEL;
  if (options.mode === 'quality') {
    assertQualityModelPinMatches(extensionModelSource);
  } else {
    assertFastModelPinMatches(extensionModelSource);
  }

  await Promise.all([
    mkdir(dirname(audioOutput), { recursive: true }),
    mkdir(dirname(jsonOutput), { recursive: true }),
    mkdir(dirname(markdownOutput), { recursive: true })
  ]);

  console.error(
    `[Voice Vac] Extracting ${options.durationSeconds}s from ${options.startSeconds}s as 16 kHz mono PCM WAV...`
  );
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(options.startSeconds),
    '-i', input,
    '-t', String(options.durationSeconds),
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    audioOutput
  ]);

  const rawAudio = await captureFfmpeg([
    '-hide_banner',
    '-loglevel', 'error',
    '-i', audioOutput,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_f32le',
    '-f', 'f32le',
    'pipe:1'
  ], Math.ceil(options.durationSeconds * 16_000 * 4) + 1_048_576);
  const audio = decodeFloat32Le(rawAudio);
  const actualDurationSeconds = audio.length / 16_000;
  if (audio.length === 0) {
    throw new Error('FFmpeg extracted an empty audio segment.');
  }

  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = 'https://huggingface.co/';
  const modelCacheState = await detectModelCacheState(model);

  let lastProgressBucket = -1;
  console.error(
    `[Voice Vac] Loading ${model.id}@${model.revision} (${model.dtype}) for local inference...`
  );
  const modelLoadStartedAt = performance.now();
  const transcriber = await pipeline('automatic-speech-recognition', model.id, {
    device: 'cpu',
    dtype: model.dtype,
    progress_callback: (event) => {
      const progress = Number(event.progress);
      if (!Number.isFinite(progress)) return;
      const bucket = Math.floor(Math.min(100, Math.max(0, progress)) / 10);
      if (bucket > lastProgressBucket) {
        lastProgressBucket = bucket;
        console.error(`[Voice Vac] Model artifacts: ${bucket * 10}%`);
      }
    },
    revision: model.revision
  });
  const modelLoadSeconds = (performance.now() - modelLoadStartedAt) / 1000;

  let output;
  const startedAt = performance.now();
  try {
    console.error(`[Voice Vac] Running ${options.mode} local ASR on ${actualDurationSeconds.toFixed(3)}s audio...`);
    output = await transcriber(audio, {
      chunk_length_s: 30,
      return_timestamps: false,
      stride_length_s: 5,
      task: 'transcribe'
    });
  } finally {
    await transcriber.dispose();
  }
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const outputText = (Array.isArray(output)
    ? output.map((item) => item.text?.trim()).filter(Boolean).join(' ')
    : output?.text ?? '').trim();

  const [inputInfo, audioInfo, inputSha256, audioSha256] = await Promise.all([
    stat(input),
    stat(audioOutput),
    hashFile(input),
    hashFile(audioOutput)
  ]);
  const totalVerificationSeconds = (performance.now() - verificationStartedAt) / 1000;
  const evidence = buildEvidence({
    audioSha256,
    audioSizeBytes: audioInfo.size,
    durationSeconds: Number(actualDurationSeconds.toFixed(3)),
    elapsedSeconds,
    inputSha256,
    inputSizeBytes: inputInfo.size,
    model,
    modelCacheState,
    modelLoadSeconds,
    mode: options.mode,
    outputText,
    sourceTitle: options.sourceTitle,
    sourceUrl: options.sourceUrl,
    startSeconds: options.startSeconds,
    totalVerificationSeconds
  });

  await Promise.all([
    writeFile(jsonOutput, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8'),
    writeFile(markdownOutput, formatEvidenceMarkdown(evidence), 'utf8')
  ]);

  console.log(JSON.stringify({
    audioOutput,
    jsonOutput,
    markdownOutput,
    mode: options.mode,
    model,
    modelLoadSeconds: evidence.execution.modelLoadSeconds,
    segment: evidence.segment,
    text: outputText,
    totalVerificationSeconds: evidence.execution.totalVerificationSeconds,
    transcriptionSeconds: evidence.execution.transcriptionSeconds
  }, null, 2));
}

async function detectModelCacheState(model) {
  const cacheRoot = resolve(env.cacheDir, model.id, model.revision);
  const requiredFiles = [
    'config.json',
    'tokenizer.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx'
  ];
  try {
    await Promise.all(requiredFiles.map((file) => access(resolve(cacheRoot, file))));
    return 'warm';
  } catch {
    return 'cold';
  }
}

async function runFfmpeg(arguments_) {
  await new Promise((resolvePromise, rejectPromise) => {
    const process = spawn('ffmpeg', arguments_, { stdio: ['ignore', 'ignore', 'pipe'] });
    const errors = [];
    process.stderr.on('data', (chunk) => errors.push(chunk));
    process.on('error', rejectPromise);
    process.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`FFmpeg exited with code ${code}: ${Buffer.concat(errors).toString('utf8')}`));
      }
    });
  });
}

async function captureFfmpeg(arguments_, maximumBytes) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const process = spawn('ffmpeg', arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let outputBytes = 0;
    process.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumBytes) {
        process.kill('SIGKILL');
        rejectPromise(new Error(`Decoded PCM exceeded the ${maximumBytes}-byte safety limit.`));
        return;
      }
      output.push(chunk);
    });
    process.stderr.on('data', (chunk) => errors.push(chunk));
    process.on('error', rejectPromise);
    process.on('close', (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(output));
      } else if (outputBytes <= maximumBytes) {
        rejectPromise(new Error(`FFmpeg exited with code ${code}: ${Buffer.concat(errors).toString('utf8')}`));
      }
    });
  });
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

main().catch((error) => {
  console.error(`[Voice Vac] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
