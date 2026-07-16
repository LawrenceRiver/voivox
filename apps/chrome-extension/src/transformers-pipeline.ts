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
      return_timestamps?: boolean;
      stride_length_s?: number;
      task?: string;
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
  hasWebGpu?: () => boolean;
  loadTransformers?: () => Promise<TransformersModule>;
  wasmBaseUrl: string;
};

export function createTransformersPipelineFactory({
  hasWebGpu = defaultHasWebGpu,
  loadTransformers = loadTransformersModule,
  wasmBaseUrl
}: TransformersPipelineOptions): PipelineFactory {
  return async (task, modelId, options) => {
    const transformers = await loadTransformers();
    configureEnvironment(transformers, wasmBaseUrl);
    const devices: Device[] = hasWebGpu() ? ['webgpu', 'wasm'] : ['wasm'];
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
      return_timestamps: false,
      stride_length_s: 5,
      task: 'transcribe'
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

function defaultHasWebGpu(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
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
