import { describe, expect, it } from 'vitest';

import {
  BrowserTranscriber,
  type BrowserTranscriberState,
  type PipelineFactory,
  type SpeechRecognitionPipeline
} from '../src/browser-transcriber.js';

function speechPipeline(
  transcribe: (audio: Float32Array) => Promise<{ text: string }>,
  dispose: () => Promise<void> = async () => undefined
): SpeechRecognitionPipeline {
  return Object.assign(transcribe, { dispose });
}

describe('BrowserTranscriber', () => {
  it('reuses the loaded pipeline for repeated transcriptions in the same mode', async () => {
    const createdModels: string[] = [];
    let inferenceCount = 0;
    const pipeline = speechPipeline(async () => ({ text: `result ${++inferenceCount}` }));
    const factory: PipelineFactory = async (_task, modelId) => {
      createdModels.push(modelId);
      return pipeline;
    };
    const transcriber = new BrowserTranscriber(factory);

    await expect(transcriber.transcribe(new Float32Array([0.1]), 'quality')).resolves.toBe('result 1');
    await expect(transcriber.transcribe(new Float32Array([0.2]), 'quality')).resolves.toBe('result 2');

    expect(createdModels).toEqual(['onnx-community/whisper-base']);
  });

  it('trims model output before returning or publishing it', async () => {
    const factory: PipelineFactory = async () => speechPipeline(
      async () => ({ text: '  你好，Voice Vac。 \n' })
    );
    const transcriber = new BrowserTranscriber(factory);

    await expect(transcriber.transcribe(new Float32Array([0.1]), 'quality'))
      .resolves.toBe('你好，Voice Vac。');
  });

  it('publishes download progress and each successful lifecycle state', async () => {
    const states: BrowserTranscriberState[] = [];
    const factory: PipelineFactory = async (task, modelId, options) => {
      expect(task).toBe('automatic-speech-recognition');
      expect(modelId).toBe('onnx-community/whisper-base');
      expect(options.dtype).toBe('q8');
      expect(options.revision).toBe('1846881b6b3a3024392c1eea3ad983695bc23925');
      options.progress_callback({ status: 'progress', progress: 37.5 });
      return speechPipeline(async () => ({ text: 'ready' }));
    };
    const transcriber = new BrowserTranscriber(factory, (state) => states.push(state));

    expect(transcriber.state).toEqual({ phase: 'idle' });
    await transcriber.transcribe(new Float32Array([0.1]), 'quality');

    expect(states).toEqual([
      { mode: 'quality', phase: 'downloading', progress: 0 },
      { mode: 'quality', phase: 'downloading', progress: 37.5 },
      { mode: 'quality', phase: 'transcribing' },
      { mode: 'quality', phase: 'complete', text: 'ready' }
    ]);
    expect(transcriber.state).toEqual({ mode: 'quality', phase: 'complete', text: 'ready' });
  });

  it('disposes the previous pipeline before loading a different mode', async () => {
    const events: string[] = [];
    const factory: PipelineFactory = async (_task, modelId) => {
      events.push(`load:${modelId}`);
      return speechPipeline(
        async () => {
          events.push(`infer:${modelId}`);
          return { text: modelId };
        },
        async () => {
          events.push(`dispose:${modelId}`);
        }
      );
    };
    const transcriber = new BrowserTranscriber(factory);

    await transcriber.transcribe(new Float32Array([0.1]), 'quality');
    await transcriber.transcribe(new Float32Array([0.2]), 'fast');

    expect(events).toEqual([
      'load:onnx-community/whisper-base',
      'infer:onnx-community/whisper-base',
      'dispose:onnx-community/whisper-base',
      'load:onnx-community/whisper-tiny',
      'infer:onnx-community/whisper-tiny'
    ]);
  });

  it('serializes inference requests so one pipeline is never run concurrently', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let inferenceStarts = 0;
    let activeInferences = 0;
    let maximumConcurrency = 0;
    const factory: PipelineFactory = async () => speechPipeline(async (audio) => {
      inferenceStarts += 1;
      activeInferences += 1;
      maximumConcurrency = Math.max(maximumConcurrency, activeInferences);
      if (audio[0] === 1) {
        await firstGate;
      }
      activeInferences -= 1;
      return { text: String(audio[0]) };
    });
    const transcriber = new BrowserTranscriber(factory);

    const first = transcriber.transcribe(new Float32Array([1]), 'fast');
    await Promise.resolve();
    await Promise.resolve();
    const second = transcriber.transcribe(new Float32Array([2]), 'fast');
    await Promise.resolve();
    await Promise.resolve();

    expect(inferenceStarts).toBe(1);
    expect(maximumConcurrency).toBe(1);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['1', '2']);
    expect(maximumConcurrency).toBe(1);
  });

  it('keeps the failed audio retryable and reuses a pipeline that loaded successfully', async () => {
    let factoryCalls = 0;
    let inferenceAttempts = 0;
    const audio = new Float32Array([0.25, -0.1]);
    const factory: PipelineFactory = async () => {
      factoryCalls += 1;
      return speechPipeline(async (receivedAudio) => {
        inferenceAttempts += 1;
        expect(receivedAudio).toBe(audio);
        if (inferenceAttempts === 1) {
          throw new Error('ONNX session interrupted');
        }
        return { text: '  recovered transcript  ' };
      });
    };
    const transcriber = new BrowserTranscriber(factory);

    await expect(transcriber.transcribe(audio, 'fast')).rejects.toThrow('ONNX session interrupted');
    expect(transcriber.state).toEqual({
      canRetry: true,
      message: 'ONNX session interrupted',
      mode: 'fast',
      phase: 'error'
    });

    await expect(transcriber.retry()).resolves.toBe('recovered transcript');
    expect(factoryCalls).toBe(1);
    expect(inferenceAttempts).toBe(2);
    expect(transcriber.state).toEqual({
      mode: 'fast',
      phase: 'complete',
      text: 'recovered transcript'
    });
  });

  it('disposes the loaded model and returns to idle without double disposal', async () => {
    let disposeCalls = 0;
    const factory: PipelineFactory = async () => speechPipeline(
      async () => ({ text: 'complete' }),
      async () => {
        disposeCalls += 1;
      }
    );
    const transcriber = new BrowserTranscriber(factory);
    await transcriber.transcribe(new Float32Array([0.1]), 'quality');

    await transcriber.dispose();
    await transcriber.dispose();

    expect(disposeCalls).toBe(1);
    expect(transcriber.state).toEqual({ phase: 'idle' });
  });

  it('clears the loaded pipeline even when final disposal rejects', async () => {
    let disposeCalls = 0;
    const factory: PipelineFactory = async () => speechPipeline(
      async () => ({ text: 'complete' }),
      async () => {
        disposeCalls += 1;
        throw new Error('GPU disposal failed');
      }
    );
    const transcriber = new BrowserTranscriber(factory);
    await transcriber.transcribe(new Float32Array([0.1]), 'quality');

    await expect(transcriber.dispose()).rejects.toThrow('GPU disposal failed');
    await expect(transcriber.dispose()).resolves.toBeUndefined();

    expect(disposeCalls).toBe(1);
    expect(transcriber.state).toEqual({ phase: 'idle' });
  });

  it('can load the new mode after a switch disposal rejects', async () => {
    const loadedModels: string[] = [];
    let qualityDisposals = 0;
    const factory: PipelineFactory = async (_task, modelId) => {
      loadedModels.push(modelId);
      return speechPipeline(
        async () => ({ text: modelId }),
        async () => {
          if (modelId === 'onnx-community/whisper-base') {
            qualityDisposals += 1;
            throw new Error('old model would not dispose');
          }
        }
      );
    };
    const transcriber = new BrowserTranscriber(factory);
    await transcriber.transcribe(new Float32Array([0.1]), 'quality');

    await expect(transcriber.transcribe(new Float32Array([0.2]), 'fast'))
      .rejects.toThrow('old model would not dispose');
    await expect(transcriber.transcribe(new Float32Array([0.2]), 'fast'))
      .resolves.toBe('onnx-community/whisper-tiny');

    expect(qualityDisposals).toBe(1);
    expect(loadedModels).toEqual([
      'onnx-community/whisper-base',
      'onnx-community/whisper-tiny'
    ]);
  });

  it('does not turn a successful inference into an error when a state observer throws', async () => {
    const factory: PipelineFactory = async () => speechPipeline(
      async () => ({ text: 'still successful' })
    );
    const transcriber = new BrowserTranscriber(factory, () => {
      throw new Error('popup was closed');
    });

    await expect(transcriber.transcribe(new Float32Array([0.1]), 'quality'))
      .resolves.toBe('still successful');
    expect(transcriber.state).toEqual({
      mode: 'quality',
      phase: 'complete',
      text: 'still successful'
    });
  });

  it('coalesces duplicate retries into the same in-flight promise', async () => {
    let attempts = 0;
    const factory: PipelineFactory = async () => speechPipeline(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary inference failure');
      }
      return { text: 'retried once' };
    });
    const transcriber = new BrowserTranscriber(factory);
    await expect(transcriber.transcribe(new Float32Array([0.1]), 'fast'))
      .rejects.toThrow('temporary inference failure');

    const firstRetry = transcriber.retry();
    const duplicateRetry = transcriber.retry();
    await expect(Promise.all([firstRetry, duplicateRetry]))
      .resolves.toEqual(['retried once', 'retried once']);

    expect(duplicateRetry).toBe(firstRetry);
    expect(attempts).toBe(2);
  });

  it('aggregates multi-file download bytes into monotonic overall progress', async () => {
    const progressValues: number[] = [];
    const factory: PipelineFactory = async (_task, _modelId, options) => {
      options.progress_callback({
        file: 'encoder.onnx',
        loaded: 0,
        status: 'initiate',
        total: 100
      });
      options.progress_callback({
        file: 'decoder.onnx',
        loaded: 0,
        status: 'initiate',
        total: 300
      });
      options.progress_callback({
        file: 'encoder.onnx',
        loaded: 50,
        progress: 50,
        status: 'progress',
        total: 100
      });
      options.progress_callback({
        file: 'decoder.onnx',
        loaded: 150,
        progress: 50,
        status: 'progress',
        total: 300
      });
      options.progress_callback({
        file: 'encoder.onnx',
        loaded: 20,
        progress: 20,
        status: 'progress',
        total: 100
      });
      return speechPipeline(async () => ({ text: 'complete' }));
    };
    const transcriber = new BrowserTranscriber(factory, (state) => {
      if (state.phase === 'downloading') {
        progressValues.push(state.progress);
      }
    });

    await transcriber.transcribe(new Float32Array([0.1]), 'quality');

    expect(progressValues).toEqual([0, 12.5, 50]);
  });

  it('ignores callbacks from completed and superseded load generations', async () => {
    const progressCallbacks: Array<Parameters<PipelineFactory>[2]['progress_callback']> = [];
    let finishFastLoad!: (pipeline: SpeechRecognitionPipeline) => void;
    let markFastLoadStarted!: () => void;
    const fastLoadStarted = new Promise<void>((resolve) => {
      markFastLoadStarted = resolve;
    });
    const fastPipeline = new Promise<SpeechRecognitionPipeline>((resolve) => {
      finishFastLoad = resolve;
    });
    const factory: PipelineFactory = async (_task, modelId, options) => {
      progressCallbacks.push(options.progress_callback);
      if (modelId === 'onnx-community/whisper-tiny') {
        markFastLoadStarted();
        return fastPipeline;
      }
      return speechPipeline(async () => ({ text: 'quality result' }));
    };
    const transcriber = new BrowserTranscriber(factory);
    await transcriber.transcribe(new Float32Array([0.1]), 'quality');

    progressCallbacks[0]?.({
      file: 'old.onnx',
      loaded: 90,
      progress: 90,
      status: 'progress',
      total: 100
    });
    expect(transcriber.state).toEqual({
      mode: 'quality',
      phase: 'complete',
      text: 'quality result'
    });

    const fast = transcriber.transcribe(new Float32Array([0.2]), 'fast');
    await fastLoadStarted;
    progressCallbacks[0]?.({
      file: 'old.onnx',
      loaded: 100,
      progress: 100,
      status: 'done',
      total: 100
    });
    expect(transcriber.state).toEqual({
      mode: 'fast',
      phase: 'downloading',
      progress: 0
    });

    finishFastLoad(speechPipeline(async () => ({ text: 'fast result' })));
    await expect(fast).resolves.toBe('fast result');
    progressCallbacks[1]?.({
      file: 'new.onnx',
      loaded: 80,
      progress: 80,
      status: 'progress',
      total: 100
    });
    expect(transcriber.state).toEqual({
      mode: 'fast',
      phase: 'complete',
      text: 'fast result'
    });
  });

  it('ignores progress callbacks from a load generation after disposal starts', async () => {
    let reportProgress!: Parameters<PipelineFactory>[2]['progress_callback'];
    let finishLoading!: (pipeline: SpeechRecognitionPipeline) => void;
    let markFactoryStarted!: () => void;
    const factoryStarted = new Promise<void>((resolve) => {
      markFactoryStarted = resolve;
    });
    const pendingPipeline = new Promise<SpeechRecognitionPipeline>((resolve) => {
      finishLoading = resolve;
    });
    const factory: PipelineFactory = async (_task, _modelId, options) => {
      reportProgress = options.progress_callback;
      markFactoryStarted();
      return pendingPipeline;
    };
    const transcriber = new BrowserTranscriber(factory);
    const transcription = transcriber.transcribe(new Float32Array([0.1]), 'quality');
    await factoryStarted;

    const disposal = transcriber.dispose();
    reportProgress({
      file: 'model.onnx',
      loaded: 75,
      progress: 75,
      status: 'progress',
      total: 100
    });
    const stateAfterLateProgress = transcriber.state;
    finishLoading(speechPipeline(async () => ({ text: 'complete' })));
    await transcription;
    await disposal;

    expect(stateAfterLateProgress).toEqual({
      mode: 'quality',
      phase: 'downloading',
      progress: 0
    });
  });

  it('accepts only one active and one pending transcription', async () => {
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    const inferredAudio: number[] = [];
    const factory: PipelineFactory = async () => speechPipeline(async (audio) => {
      inferredAudio.push(audio[0] ?? 0);
      if (audio[0] === 1) {
        markActiveStarted();
        await activeGate;
      }
      return { text: String(audio[0]) };
    });
    const transcriber = new BrowserTranscriber(factory);

    const active = transcriber.transcribe(new Float32Array([1]), 'fast');
    await activeStarted;
    const pending = transcriber.transcribe(new Float32Array([2]), 'fast');
    const overflow = transcriber.transcribe(new Float32Array([3]), 'fast');
    const overflowRejected = expect(overflow).rejects.toThrow('Transcription queue is full.');
    releaseActive();

    await expect(Promise.all([active, pending])).resolves.toEqual(['1', '2']);
    await overflowRejected;
    expect(inferredAudio).toEqual([1, 2]);
  });

  it('blocks new work immediately on disposal and cancels work that has not started', async () => {
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    const inferredAudio: number[] = [];
    const factory: PipelineFactory = async () => speechPipeline(async (audio) => {
      inferredAudio.push(audio[0] ?? 0);
      if (audio[0] === 1) {
        markActiveStarted();
        await activeGate;
      }
      return { text: String(audio[0]) };
    });
    const transcriber = new BrowserTranscriber(factory);
    const active = transcriber.transcribe(new Float32Array([1]), 'fast');
    await activeStarted;
    const pending = transcriber.transcribe(new Float32Array([2]), 'fast');
    const pendingError = pending.then(
      () => undefined,
      (error: unknown) => error instanceof Error ? error : new Error(String(error))
    );

    const disposal = transcriber.dispose();
    await expect(transcriber.transcribe(new Float32Array([3]), 'fast'))
      .rejects.toThrow('BrowserTranscriber has been disposed.');
    releaseActive();

    await expect(active).resolves.toBe('1');
    await expect(pendingError).resolves.toMatchObject({
      message: 'BrowserTranscriber has been disposed.'
    });
    await expect(disposal).resolves.toBeUndefined();
    expect(inferredAudio).toEqual([1]);
  });
});
