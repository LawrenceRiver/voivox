import { describe, expect, it, vi } from 'vitest';

import {
  createTransformersPipelineFactory,
  type TransformersModule
} from '../src/transformers-pipeline.js';

describe('Transformers.js pipeline adapter', () => {
  it('keeps q8 Whisper on single-thread WASM even when WebGPU is available', async () => {
    const devices: string[] = [];
    let inferenceOptions: Record<string, unknown> | undefined;
    let disposeCalls = 0;
    const module = fakeTransformersModule(async (_task, _model, options) => {
      devices.push(options.device);
      return Object.assign(
        async (_audio: Float32Array, options?: Record<string, unknown>) => {
          inferenceOptions = options;
          return [{ text: ' 第一段 ' }, { text: '第二段 ' }];
        },
        { dispose: async () => { disposeCalls += 1; } }
      );
    });
    const factory = createTransformersPipelineFactory({
      loadTransformers: async () => module,
      wasmBaseUrl: 'chrome-extension://voivox/wasm/'
    });

    const pipeline = await factory('automatic-speech-recognition', 'model-id', {
      dtype: 'q8',
      progress_callback: () => undefined,
      revision: 'pinned-revision'
    });

    expect(devices).toEqual(['wasm']);
    expect(module.env).toMatchObject({
      allowLocalModels: false,
      allowRemoteModels: true,
      remoteHost: 'https://huggingface.co/',
      useBrowserCache: true
    });
    expect(module.env.backends.onnx.wasm).toEqual({
      numThreads: 1,
      wasmPaths: 'chrome-extension://voivox/wasm/'
    });
    await expect(pipeline(new Float32Array([0.1]))).resolves.toEqual({ text: '第一段 第二段' });
    expect(inferenceOptions).toMatchObject({
      do_sample: false,
      force_full_sequences: false,
      max_new_tokens: 32,
      no_repeat_ngram_size: 3,
      repetition_penalty: 1.1,
      top_k: 0
    });
    await pipeline.dispose();
    expect(disposeCalls).toBe(1);
  });

  it('uses WASM directly when WebGPU is not available', async () => {
    const pipelineFactory = vi.fn<TransformersModule['pipeline']>(async () => Object.assign(
      async () => ({ text: 'local result' }),
      { dispose: async () => undefined }
    ));
    const module = fakeTransformersModule(pipelineFactory);
    const factory = createTransformersPipelineFactory({
      loadTransformers: async () => module,
      wasmBaseUrl: 'chrome-extension://voivox/wasm/'
    });

    await factory('automatic-speech-recognition', 'model-id', {
      dtype: 'q8',
      progress_callback: () => undefined,
      revision: 'pinned-revision'
    });

    expect(pipelineFactory.mock.calls[0]?.[2]).toMatchObject({
      device: 'wasm',
      dtype: 'q8',
      revision: 'pinned-revision'
    });
  });
});

function fakeTransformersModule(pipeline: TransformersModule['pipeline']): TransformersModule {
  return {
    env: {
      allowLocalModels: true,
      allowRemoteModels: true,
      backends: { onnx: {} },
      remoteHost: '',
      useBrowserCache: false
    },
    pipeline
  };
}
