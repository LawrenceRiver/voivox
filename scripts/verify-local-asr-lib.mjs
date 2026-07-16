export const FAST_MODEL = Object.freeze({
  dtype: 'q8',
  id: 'onnx-community/whisper-tiny',
  revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7'
});

export const QUALITY_MODEL = Object.freeze({
  dtype: 'q8',
  id: 'onnx-community/whisper-base',
  revision: '1846881b6b3a3024392c1eea3ad983695bc23925'
});

const CLI_OPTION_NAMES = new Set([
  '--audio-output',
  '--duration',
  '--input',
  '--json-output',
  '--markdown-output',
  '--mode',
  '--source-title',
  '--source-url',
  '--start'
]);

export function parseVerificationArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!CLI_OPTION_NAMES.has(name)) {
      throw new Error(`Unknown option: ${name ?? '[missing]'}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Option ${name} requires a value.`);
    }
    values.set(name, value);
  }

  const durationSeconds = Number(values.get('--duration') ?? 30);
  const mode = values.get('--mode') ?? 'fast';
  const startSeconds = Number(values.get('--start') ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('--duration must be a positive number.');
  }
  if (!Number.isFinite(startSeconds) || startSeconds < 0) {
    throw new Error('--start must be a non-negative number.');
  }
  if (mode !== 'fast' && mode !== 'quality') {
    throw new Error('--mode must be fast or quality.');
  }

  const required = [
    '--input',
    '--audio-output',
    '--json-output',
    '--markdown-output',
    '--source-title',
    '--source-url'
  ];
  for (const name of required) {
    if (!values.get(name)) {
      throw new Error(`Missing required option: ${name}`);
    }
  }

  return {
    audioOutput: values.get('--audio-output'),
    durationSeconds,
    input: values.get('--input'),
    jsonOutput: values.get('--json-output'),
    markdownOutput: values.get('--markdown-output'),
    mode,
    sourceTitle: values.get('--source-title'),
    sourceUrl: values.get('--source-url'),
    startSeconds
  };
}

export function assertFastModelPinMatches(extensionSource) {
  const fastBlock = extensionSource.match(/fast\s*:\s*\{([\s\S]*?)\}\s*,\s*quality\s*:/)?.[1];
  const expectedValues = [FAST_MODEL.id, FAST_MODEL.revision, FAST_MODEL.dtype];
  if (!fastBlock || expectedValues.some((value) => !fastBlock.includes(`'${value}'`))) {
    throw new Error('Verification model pin does not match the extension fast-mode source.');
  }
}

export function assertQualityModelPinMatches(extensionSource) {
  const qualityBlock = extensionSource.match(/quality\s*:\s*\{([\s\S]*?)\}/)?.[1];
  const expectedValues = [QUALITY_MODEL.id, QUALITY_MODEL.revision, QUALITY_MODEL.dtype];
  if (!qualityBlock || expectedValues.some((value) => !qualityBlock.includes(`'${value}'`))) {
    throw new Error('Verification model pin does not match the extension quality-mode source.');
  }
}

export function decodeFloat32Le(bytes) {
  if (bytes.byteLength % 4 !== 0) {
    throw new Error('Float32 PCM must contain a multiple of four bytes.');
  }

  const audio = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < audio.length; index += 1) {
    audio[index] = bytes.readFloatLE(index * 4);
  }
  return audio;
}

export function buildEvidence({
  audioSha256,
  audioSizeBytes,
  durationSeconds,
  elapsedSeconds,
  inputSha256,
  inputSizeBytes,
  model,
  modelCacheState,
  modelLoadSeconds,
  mode,
  outputText,
  recordedAt = new Date().toISOString(),
  sourceTitle,
  sourceUrl,
  startSeconds,
  totalVerificationSeconds
}) {
  return {
    schemaVersion: 1,
    recordedAt,
    source: {
      title: sourceTitle,
      url: sourceUrl,
      inputSha256,
      inputSizeBytes
    },
    segment: {
      startSeconds,
      durationSeconds
    },
    audio: {
      channels: 1,
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 16_000,
      sha256: audioSha256,
      sizeBytes: audioSizeBytes
    },
    model: {
      ...model,
      library: '@huggingface/transformers',
      libraryVersion: '3.8.1',
      mode
    },
    execution: {
      inferenceLocation: 'local-machine',
      modelCacheStateBeforeRun: modelCacheState,
      modelLoadSeconds: Number(modelLoadSeconds.toFixed(3)),
      runtime: 'Transformers.js + ONNX Runtime CPU verification harness',
      speechApiUsed: false,
      totalVerificationSeconds: Number(totalVerificationSeconds.toFixed(3)),
      transcriptionSeconds: Number(elapsedSeconds.toFixed(3))
    },
    result: {
      text: outputText
    },
    limitations: [
      'This is one real-path smoke test, not a word-error-rate benchmark.',
      'The selected source is a music mix; vocals and instrumental backing can reduce speech-recognition accuracy.',
      `The Node verification harness uses the same pinned q8 model as VOIVOX ${mode} mode, but it does not replace an in-browser extension UI test.`
    ]
  };
}

export function formatEvidenceMarkdown(evidence) {
  return `# VOIVOX local-ASR smoke-test evidence

- Source: [${evidence.source.title}](${evidence.source.url})
- Segment: ${evidence.segment.startSeconds}s–${evidence.segment.startSeconds + evidence.segment.durationSeconds}s (${evidence.segment.durationSeconds}s)
- Audio: 16 kHz mono PCM WAV
- Mode: ${evidence.model.mode}
- Model: \`${evidence.model.id}\` at \`${evidence.model.revision}\` (${evidence.model.dtype})
- Runtime: ${evidence.execution.runtime}
- Model cache before run: ${evidence.execution.modelCacheStateBeforeRun}
- Model setup: ${evidence.execution.modelLoadSeconds}s
- Transcription phase: ${evidence.execution.transcriptionSeconds}s (model setup excluded)
- Total verification command: ${evidence.execution.totalVerificationSeconds}s
- Privacy: **No speech API was used.** The audio was decoded and inferred on the local machine.

## Raw model output

> ${evidence.result.text || '[empty output]'}

## Scope and limitations

This is a reproducible end-to-end smoke test, not an accuracy score. The source is a music mix, so backing instrumentation and sung vocals may reduce recognition quality. The harness verifies local inference with the same pinned q8 model used by VOIVOX ${evidence.model.mode} mode; it does not substitute for the separate Chrome-extension UI test.

- Input SHA-256: \`${evidence.source.inputSha256}\`
- Extracted-audio SHA-256: \`${evidence.audio.sha256}\`
`;
}
