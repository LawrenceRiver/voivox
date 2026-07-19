export const QWEN_MODEL = Object.freeze({
  id: 'Qwen/Qwen3-ASR-0.6B',
  revision: '5eb144179a02acc5e5ba31e748d22b0cf3e303b0',
  runtimePackage: 'qwen-asr',
  runtimeVersion: '0.0.6'
});

const CLI_OPTION_NAMES = new Set([
  '--audio-output',
  '--duration',
  '--input',
  '--json-output',
  '--markdown-output',
  '--model-path',
  '--python-command',
  '--source-title',
  '--source-url',
  '--start'
]);

export function parseVerificationArguments(argv) {
  if (argv.length % 2 !== 0) throw new Error(`Option ${argv.at(-1)} requires a value.`);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!CLI_OPTION_NAMES.has(name)) throw new Error(`Unknown option: ${name ?? '[missing]'}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`Option ${name} requires a value.`);
    if (values.has(name)) throw new Error(`Duplicate option: ${name}`);
    values.set(name, value);
  }

  const durationSeconds = Number(values.get('--duration') ?? 30);
  const startSeconds = Number(values.get('--start') ?? 0);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600) {
    throw new Error('--duration must be a positive number no greater than 600.');
  }
  if (!Number.isFinite(startSeconds) || startSeconds < 0) {
    throw new Error('--start must be a non-negative number.');
  }

  const required = [
    '--input', '--audio-output', '--json-output', '--markdown-output',
    '--model-path', '--python-command', '--source-title', '--source-url'
  ];
  for (const name of required) {
    if (!values.get(name)) throw new Error(`Missing required option: ${name}`);
  }

  return {
    audioOutput: values.get('--audio-output'),
    durationSeconds,
    input: values.get('--input'),
    jsonOutput: values.get('--json-output'),
    markdownOutput: values.get('--markdown-output'),
    modelPath: values.get('--model-path'),
    pythonCommand: values.get('--python-command'),
    sourceTitle: values.get('--source-title'),
    sourceUrl: values.get('--source-url'),
    startSeconds
  };
}

export function parseWorkerProtocol(lines, requestId) {
  let ready;
  let accepted = false;
  let result;
  for (const line of lines) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      throw new Error('Voice VAC worker emitted invalid NDJSON.');
    }
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string') {
      throw new Error('Voice VAC worker emitted an invalid protocol frame.');
    }
    if (frame.type === 'status') {
      if (frame.status !== 'booting' && frame.status !== 'model_loading') {
        throw new Error('Voice VAC worker emitted an invalid status frame.');
      }
    } else if (frame.type === 'ready') {
      if (ready || !isValidReadyFrame(frame)) {
        throw new Error('Voice VAC worker emitted an invalid ready frame.');
      }
      ready = frame;
    } else if (frame.type === 'accepted') {
      if (!ready || accepted || frame.id !== requestId) throw new Error('Voice VAC worker accepted out of order.');
      accepted = true;
    } else if (frame.type === 'result') {
      if (!accepted || result || frame.id !== requestId || typeof frame.text !== 'string') {
        throw new Error('Voice VAC worker returned an invalid result frame.');
      }
      if (frame.language !== null && typeof frame.language !== 'string') {
        throw new Error('Voice VAC worker returned an invalid language.');
      }
      result = frame;
    } else if (frame.type === 'fatal' || frame.type === 'error') {
      throw new Error(`${frame.code ?? 'ASR_INFERENCE_FAILED'}: ${frame.error ?? 'Local ASR failed.'}`);
    } else {
      throw new Error(`Voice VAC worker emitted unknown frame type: ${frame.type}`);
    }
  }
  if (!ready || !accepted || !result) throw new Error('Voice VAC worker protocol did not complete.');
  return {
    device: ready.device,
    language: result.language,
    modelRevision: ready.model_revision,
    pythonVersion: ready.python_version,
    runtimePackage: ready.runtime_package,
    runtimeVersion: ready.runtime_version,
    speechApiUsed: ready.speech_api_used,
    text: result.text
  };
}

export function buildEvidence({
  audioSha256,
  audioSizeBytes,
  device,
  durationSeconds,
  inferenceSeconds,
  inputSha256,
  inputSizeBytes,
  language,
  modelLoadSeconds,
  modelPath,
  runtime,
  outputText,
  recordedAt = new Date().toISOString(),
  sourceTitle,
  sourceUrl,
  startSeconds,
  totalVerificationSeconds,
  hardware
}) {
  return {
    schemaVersion: 2,
    recordedAt,
    source: { title: sourceTitle, url: sourceUrl, inputSha256, inputSizeBytes },
    segment: { startSeconds, durationSeconds },
    audio: {
      channels: 1,
      codec: 'pcm_s16le',
      container: 'wav',
      sampleRateHz: 16_000,
      sha256: audioSha256,
      sizeBytes: audioSizeBytes
    },
    model: { ...QWEN_MODEL, revision: runtime.modelRevision, path: modelPath },
    hardware,
    execution: {
      device,
      inferenceLocation: 'local-machine',
      modelCacheStateBeforeRun: 'verified-pinned-snapshot',
      modelLoadSeconds: rounded(modelLoadSeconds),
      inferenceSeconds: rounded(inferenceSeconds),
      pythonVersion: runtime.pythonVersion,
      runtimePackage: runtime.runtimePackage,
      runtimePackageVersion: runtime.runtimeVersion,
      runtime: `Python ${runtime.pythonVersion} + ${runtime.runtimePackage} ${runtime.runtimeVersion} Transformers backend`,
      speechApiUsed: runtime.speechApiUsed,
      totalVerificationSeconds: rounded(totalVerificationSeconds)
    },
    result: { language, text: outputText },
    limitations: [
      'This is one real-path smoke test, not a word-error-rate benchmark.',
      'Model installation and download time are excluded from modelLoadSeconds.',
      'Website availability and media acquisition are evaluated separately.'
    ]
  };
}

export function formatEvidenceMarkdown(evidence) {
  return `# Voice VAC local Qwen ASR evidence

- Source: [${evidence.source.title}](${evidence.source.url})
- Segment: ${evidence.segment.startSeconds}s–${evidence.segment.startSeconds + evidence.segment.durationSeconds}s (${evidence.segment.durationSeconds}s)
- Audio: 16 kHz mono PCM WAV
- Model: \`${evidence.model.id}\` at \`${evidence.model.revision}\`
- Runtime: ${evidence.execution.runtime}
- Device: \`${evidence.execution.device}\`
- Model load: ${evidence.execution.modelLoadSeconds}s
- Inference: ${evidence.execution.inferenceSeconds}s
- Total verification: ${evidence.execution.totalVerificationSeconds}s
- Privacy: **No speech API was used.** Audio inference ran on the local machine with the pinned external snapshot.

## Raw model output

> ${evidence.result.text || '[empty output]'}

Language: \`${evidence.result.language ?? 'auto'}\`

## Reproducibility

- Input SHA-256: \`${evidence.source.inputSha256}\`
- Extracted-audio SHA-256: \`${evidence.audio.sha256}\`
- Model path: \`${evidence.model.path}\`
`;
}

function rounded(value) {
  return Number(Number(value).toFixed(3));
}

export function isValidReadyFrame(frame) {
  return frame
    && typeof frame === 'object'
    && frame.model_id === QWEN_MODEL.id
    && frame.model_revision === QWEN_MODEL.revision
    && typeof frame.device === 'string'
    && frame.device.length > 0
    && typeof frame.python_version === 'string'
    && /^3\.12\.\d+$/u.test(frame.python_version)
    && frame.runtime_package === QWEN_MODEL.runtimePackage
    && frame.runtime_version === QWEN_MODEL.runtimeVersion
    && frame.speech_api_used === false
    && frame.offline === true;
}
