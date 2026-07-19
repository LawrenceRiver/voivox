#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { cpus, freemem, homedir, platform, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  QWEN_MODEL,
  buildEvidence,
  formatEvidenceMarkdown,
  isValidReadyFrame,
  parseVerificationArguments
} from './verify-local-asr-lib.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

async function main() {
  const verificationStartedAt = performance.now();
  const options = parseVerificationArguments(process.argv.slice(2));
  const paths = Object.fromEntries(
    ['input', 'audioOutput', 'jsonOutput', 'markdownOutput', 'modelPath']
      .map((key) => [key, resolve(options[key].replace(/^~(?=\/)/u, homedir()) )])
  );
  await verifyModelManifest(paths.modelPath);
  await Promise.all([
    mkdir(dirname(paths.audioOutput), { recursive: true }),
    mkdir(dirname(paths.jsonOutput), { recursive: true }),
    mkdir(dirname(paths.markdownOutput), { recursive: true })
  ]);

  console.error(`[Voice VAC] Extracting ${options.durationSeconds}s as 16 kHz mono PCM...`);
  await runProcess('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-ss', String(options.startSeconds), '-i', paths.input,
    '-t', String(options.durationSeconds), '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', paths.audioOutput
  ]);
  const pcm = await captureProcess('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', paths.audioOutput,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'
  ], Math.ceil(options.durationSeconds * 32_000) + 65_536);
  if (!pcm.length || pcm.length % 2) throw new Error('FFmpeg extracted invalid PCM16 audio.');
  const actualDurationSeconds = pcm.length / 32_000;

  const worker = await runWorker({
    modelPath: paths.modelPath,
    pcm,
    pythonCommand: options.pythonCommand,
    workerPath: resolve(repositoryRoot, 'native/asr/voivox_asr_worker.py')
  });
  const [inputInfo, audioInfo, inputSha256, audioSha256] = await Promise.all([
    stat(paths.input), stat(paths.audioOutput), hashFile(paths.input), hashFile(paths.audioOutput)
  ]);
  const evidence = buildEvidence({
    audioSha256,
    audioSizeBytes: audioInfo.size,
    device: worker.device,
    durationSeconds: Number(actualDurationSeconds.toFixed(3)),
    hardware: {
      architecture: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      freeMemoryBytes: freemem(),
      operatingSystem: platform(),
      totalMemoryBytes: totalmem()
    },
    inferenceSeconds: worker.inferenceSeconds,
    inputSha256,
    inputSizeBytes: inputInfo.size,
    language: worker.language,
    modelLoadSeconds: worker.modelLoadSeconds,
    modelPath: paths.modelPath,
    outputText: worker.text,
    runtime: {
      modelRevision: worker.modelRevision,
      pythonVersion: worker.pythonVersion,
      runtimePackage: worker.runtimePackage,
      runtimeVersion: worker.runtimeVersion,
      speechApiUsed: worker.speechApiUsed
    },
    sourceTitle: options.sourceTitle,
    sourceUrl: options.sourceUrl,
    startSeconds: options.startSeconds,
    totalVerificationSeconds: (performance.now() - verificationStartedAt) / 1000
  });
  await Promise.all([
    writeFile(paths.jsonOutput, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8'),
    writeFile(paths.markdownOutput, formatEvidenceMarkdown(evidence), 'utf8')
  ]);
  console.log(JSON.stringify({
    device: worker.device,
    language: worker.language,
    model: QWEN_MODEL,
    text: worker.text,
    timings: evidence.execution
  }, null, 2));
}

async function verifyModelManifest(modelPath) {
  const [manifestText, configText] = await Promise.all([
    readFile(resolve(modelPath, 'model-manifest.json'), 'utf8'),
    readFile(resolve(modelPath, 'config.json'), 'utf8')
  ]);
  const manifest = JSON.parse(manifestText);
  const configSha256 = createHash('sha256').update(configText, 'utf8').digest('hex');
  if (manifest.schemaVersion !== 1 || manifest.repoId !== QWEN_MODEL.id
      || manifest.revision !== QWEN_MODEL.revision || manifest.modelPath !== modelPath
      || manifest.configSha256 !== configSha256) {
    throw new Error('The local Qwen model manifest does not match the pinned Voice VAC snapshot.');
  }
}

async function runWorker({ modelPath, pcm, pythonCommand, workerPath }) {
  const startedAt = performance.now();
  const child = spawn(pythonCommand, [workerPath], {
    env: {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      VOICE_VAC_QWEN_MODEL_PATH: modelPath
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdoutBuffer = '';
  let stderr = '';
  let settled = false;
  let readyAt;
  let readyDevice;
  let readyMetadata;
  let acceptedAt;
  let completedResult;
  const requestId = 'verify_1';

  return await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => finish(new Error('Local Qwen verification timed out.')), 20 * 60_000);
    timeout.unref();
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        child.kill('SIGKILL');
        rejectPromise(error);
      } else {
        resolvePromise(result);
      }
    };
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
    child.once('error', finish);
    child.once('close', (code) => {
      if (settled) return;
      if (code === 0 && completedResult) finish(undefined, completedResult);
      else finish(new Error(stderr || `Local Qwen worker exited with code ${code}.`));
    });
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { finish(new Error('Local Qwen worker emitted invalid NDJSON.')); return; }
        if (frame.type === 'status') continue;
        if (frame.type === 'ready') {
          if (readyAt || !isValidReadyFrame(frame)) {
            finish(new Error('Local Qwen worker emitted an invalid ready frame.')); return;
          }
          readyAt = performance.now();
          readyDevice = frame.device;
          readyMetadata = frame;
          child.stdin.write(`${JSON.stringify({
            id: requestId,
            pcm: pcm.toString('base64'),
            sampleRate: 16000,
            channels: 1,
            language: null
          })}\n`);
        } else if (frame.type === 'accepted') {
          if (!readyAt || frame.id !== requestId || acceptedAt) {
            finish(new Error('Local Qwen worker accepted out of order.')); return;
          }
          acceptedAt = performance.now();
        } else if (frame.type === 'result') {
          if (!acceptedAt || frame.id !== requestId || typeof frame.text !== 'string') {
            finish(new Error('Local Qwen worker returned an invalid result.')); return;
          }
          const completedAt = performance.now();
          completedResult = {
            device: readyDevice,
            inferenceSeconds: (completedAt - acceptedAt) / 1000,
            language: frame.language ?? null,
            modelRevision: readyMetadata.model_revision,
            modelLoadSeconds: (readyAt - startedAt) / 1000,
            pythonVersion: readyMetadata.python_version,
            runtimePackage: readyMetadata.runtime_package,
            runtimeVersion: readyMetadata.runtime_version,
            speechApiUsed: readyMetadata.speech_api_used,
            text: frame.text
          };
          child.stdin.end();
        } else if (frame.type === 'fatal' || frame.type === 'error') {
          finish(new Error(`${frame.code}: ${frame.error}`));
        } else {
          finish(new Error(`Local Qwen worker emitted unknown frame: ${frame.type}`));
        }
      }
    });
  });
}

async function runProcess(command, arguments_) {
  await captureProcess(command, arguments_, 0);
}

async function captureProcess(command, arguments_, maximumBytes) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let outputBytes = 0;
    let rejected = false;
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (maximumBytes >= 0 && outputBytes > maximumBytes) {
        rejected = true;
        child.kill('SIGKILL');
        rejectPromise(new Error(`Process output exceeded ${maximumBytes} bytes.`));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.once('error', rejectPromise);
    child.once('close', (code) => {
      if (rejected) return;
      if (code === 0) resolvePromise(Buffer.concat(output));
      else rejectPromise(new Error(`${command} exited with code ${code}: ${Buffer.concat(errors).toString('utf8')}`));
    });
  });
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
