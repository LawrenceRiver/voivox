import type {
  PipelineFactory,
  PipelineProgress,
  SpeechRecognitionPipeline
} from './browser-transcriber.js';

type Device = 'webgpu' | 'wasm';

type RawSpeechRecognitionOutput = { text: string } | Array<{ text: string }>;

type RawSpeechRecognitionPipeline = {
  (
    audio: Float32Array,
    options?: {
      chunk_length_s?: number;
      do_sample?: boolean;
      force_full_sequences?: boolean;
      max_new_tokens?: number;
      no_repeat_ngram_size?: number;
      repetition_penalty?: number;
      return_timestamps?: boolean;
      stride_length_s?: number;
      task?: string;
      top_k?: number;
    }
  ): Promise<RawSpeechRecognitionOutput>;
  dispose(): Promise<void> | void;
};

export type TransformersModule = {
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    backends: {
      onnx: {
        wasm?: {
          numThreads?: number;
          wasmPaths?: string;
        };
      };
    };
    remoteHost: string;
    useBrowserCache: boolean;
  };
  pipeline: (
    task: 'automatic-speech-recognition',
    modelId: string,
    options: {
      device: Device;
      dtype: 'q8';
      progress_callback: (progress: PipelineProgress) => void;
      revision: string;
    }
  ) => Promise<RawSpeechRecognitionPipeline>;
};

export type TransformersPipelineOptions = {
  loadTransformers?: () => Promise<TransformersModule>;
  wasmBaseUrl: string;
};

export function createTransformersPipelineFactory({
  loadTransformers = loadTransformersModule,
  wasmBaseUrl
}: TransformersPipelineOptions): PipelineFactory {
  return async (task, modelId, options) => {
    const transformers = await loadTransformers();
    configureEnvironment(transformers, wasmBaseUrl);
    // q8 Whisper is compact and reliable on WASM. Transformers.js does not
    // recommend q8 on WebGPU yet; it can produce invalid decoder output on
    // otherwise supported GPUs.
    const devices: Device[] = ['wasm'];
    let lastFailure: unknown;

    for (const device of devices) {
      try {
        const rawPipeline = await transformers.pipeline(task, modelId, {
          ...options,
          device
        });
        return adaptPipeline(rawPipeline);
      } catch (error) {
        lastFailure = error;
      }
    }

    throw lastFailure instanceof Error
      ? lastFailure
      : new Error('The browser-local speech model could not be loaded.');
  };
}

function configureEnvironment(transformers: TransformersModule, wasmBaseUrl: string): void {
  transformers.env.allowLocalModels = false;
  transformers.env.allowRemoteModels = true;
  transformers.env.remoteHost = 'https://huggingface.co/';
  transformers.env.useBrowserCache = true;
  const wasm = transformers.env.backends.onnx.wasm ?? {};
  wasm.numThreads = 1;
  wasm.wasmPaths = wasmBaseUrl.endsWith('/') ? wasmBaseUrl : `${wasmBaseUrl}/`;
  transformers.env.backends.onnx.wasm = wasm;
}

function adaptPipeline(rawPipeline: RawSpeechRecognitionPipeline): SpeechRecognitionPipeline {
  const transcribe = async (audio: Float32Array): Promise<{ text: string }> => {
    const output = await rawPipeline(audio, {
      chunk_length_s: 30,
      do_sample: false,
      force_full_sequences: false,
      max_new_tokens: Math.min(256, Math.max(32, Math.ceil(audio.length / 16_000 * 6))),
      no_repeat_ngram_size: 3,
      repetition_penalty: 1.1,
      return_timestamps: false,
      stride_length_s: 5,
      task: 'transcribe',
      top_k: 0
    });
    const text = Array.isArray(output)
      ? output.map((result) => result.text.trim()).filter(Boolean).join(' ')
      : output.text;
    return { text };
  };
  return Object.assign(transcribe, {
    dispose: () => rawPipeline.dispose()
  });
}

async function loadTransformersModule(): Promise<TransformersModule> {
  const transformers = await import('@huggingface/transformers');
  return {
    env: transformers.env as unknown as TransformersModule['env'],
    pipeline: async (task, modelId, options) => {
      const created = await transformers.pipeline(task, modelId, options);
      return created as unknown as RawSpeechRecognitionPipeline;
    }
  };
}
