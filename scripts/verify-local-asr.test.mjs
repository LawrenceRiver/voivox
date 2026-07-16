import assert from 'node:assert/strict';
import test from 'node:test';

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

test('uses the extension fast-mode model pin', () => {
  assert.deepEqual(FAST_MODEL, {
    dtype: 'q8',
    id: 'onnx-community/whisper-tiny',
    revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7'
  });
});

test('uses the extension quality-mode model pin', () => {
  assert.deepEqual(QUALITY_MODEL, {
    dtype: 'q8',
    id: 'onnx-community/whisper-base',
    revision: '1846881b6b3a3024392c1eea3ad983695bc23925'
  });
});

test('decodes little-endian float32 PCM without sharing the Buffer backing store', () => {
  const bytes = Buffer.alloc(8);
  bytes.writeFloatLE(0.25, 0);
  bytes.writeFloatLE(-0.5, 4);

  const audio = decodeFloat32Le(bytes);
  bytes.writeFloatLE(1, 0);

  assert.deepEqual([...audio], [0.25, -0.5]);
});

test('rejects an incomplete float32 PCM sample', () => {
  assert.throws(
    () => decodeFloat32Le(Buffer.alloc(3)),
    /multiple of four bytes/
  );
});

test('builds honest machine-readable and Markdown evidence', () => {
  const evidence = buildEvidence({
    audioSha256: 'audio-hash',
    audioSizeBytes: 960078,
    durationSeconds: 30,
    elapsedSeconds: 12.3456,
    inputSha256: 'video-hash',
    inputSizeBytes: 96143846,
    modelCacheState: 'warm',
    modelLoadSeconds: 3.4567,
    model: FAST_MODEL,
    mode: 'fast',
    outputText: 'Lawrence River is a virus.',
    sourceTitle: 'Abuse MV',
    sourceUrl: 'https://example.test/video',
    startSeconds: 0,
    totalVerificationSeconds: 16.2344
  });

  assert.equal(evidence.execution.speechApiUsed, false);
  assert.equal(evidence.execution.modelLoadSeconds, 3.457);
  assert.equal(evidence.execution.modelCacheStateBeforeRun, 'warm');
  assert.equal(evidence.execution.transcriptionSeconds, 12.346);
  assert.equal(evidence.execution.totalVerificationSeconds, 16.234);
  assert.equal(evidence.audio.sampleRateHz, 16000);
  assert.equal(evidence.audio.channels, 1);
  assert.equal(evidence.model.mode, 'fast');
  assert.equal(evidence.result.text, 'Lawrence River is a virus.');

  const markdown = formatEvidenceMarkdown(evidence);
  assert.match(markdown, /No speech API was used/);
  assert.match(markdown, /music mix/);
  assert.match(markdown, /Model setup: 3\.457s/);
  assert.match(markdown, /Model cache before run: warm/);
  assert.match(markdown, /Mode: fast/);
  assert.match(markdown, /Transcription phase: 12\.346s/);
  assert.match(markdown, /Lawrence River is a virus\./);
  assert.match(markdown, /ff4177021cc41f7db950912b73ea4fdf7d01d8e7/);
});

test('labels quality evidence as the VOIVOX quality model', () => {
  const evidence = buildEvidence({
    audioSha256: 'audio-hash',
    audioSizeBytes: 1,
    durationSeconds: 1,
    elapsedSeconds: 1,
    inputSha256: 'video-hash',
    inputSizeBytes: 1,
    model: QUALITY_MODEL,
    modelCacheState: 'cold',
    modelLoadSeconds: 1,
    mode: 'quality',
    outputText: 'raw',
    sourceTitle: 'title',
    sourceUrl: 'https://example.test/video',
    startSeconds: 0,
    totalVerificationSeconds: 2
  });

  assert.match(evidence.limitations[2], /VOIVOX quality mode/);
  assert.doesNotMatch(evidence.limitations[2], /VOIVOX fast mode/);
});

test('parses the reproducible verification command options', () => {
  const options = parseVerificationArguments([
    '--input', '/tmp/video.mp4',
    '--audio-output', '/tmp/segment.wav',
    '--json-output', 'docs/evidence/result.json',
    '--markdown-output', 'docs/evidence/result.md',
    '--start', '2.5',
    '--duration', '15',
    '--mode', 'quality',
    '--source-title', 'Abuse MV',
    '--source-url', 'https://example.test/video'
  ]);

  assert.deepEqual(options, {
    audioOutput: '/tmp/segment.wav',
    durationSeconds: 15,
    input: '/tmp/video.mp4',
    jsonOutput: 'docs/evidence/result.json',
    markdownOutput: 'docs/evidence/result.md',
    mode: 'quality',
    sourceTitle: 'Abuse MV',
    sourceUrl: 'https://example.test/video',
    startSeconds: 2.5
  });
});

test('rejects unsafe or incomplete verification command options', () => {
  assert.throws(
    () => parseVerificationArguments(['--input', '/tmp/video.mp4', '--duration', '0']),
    /positive number/
  );
  assert.throws(
    () => parseVerificationArguments(['--surprise', 'value']),
    /Unknown option/
  );
  assert.throws(
    () => parseVerificationArguments(['--mode', 'enormous']),
    /fast or quality/
  );
});

test('detects drift from the extension fast-mode model pin', () => {
  const matchingSource = `
    fast: {
      dtype: 'q8',
      id: 'onnx-community/whisper-tiny',
      revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7'
    },
    quality: { id: 'something-else' }
  `;
  assert.doesNotThrow(() => assertFastModelPinMatches(matchingSource));
  assert.throws(
    () => assertFastModelPinMatches(matchingSource.replace('ff4177', 'deadbe')),
    /does not match/
  );
});

test('detects drift from the extension quality-mode model pin', () => {
  const matchingSource = `
    fast: { id: 'something-else' },
    quality: {
      dtype: 'q8',
      id: 'onnx-community/whisper-base',
      revision: '1846881b6b3a3024392c1eea3ad983695bc23925'
    }
  `;
  assert.doesNotThrow(() => assertQualityModelPinMatches(matchingSource));
  assert.throws(
    () => assertQualityModelPinMatches(matchingSource.replace('184688', 'deadbe')),
    /does not match/
  );
});
