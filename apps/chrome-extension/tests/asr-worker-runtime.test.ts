import { describe, expect, it, vi } from 'vitest';

import {
  createAsrWorkerMessageHandler,
  type AsrWorkerResponse,
  type WorkerTranscriber
} from '../src/asr-worker-runtime.js';

describe('ASR worker message runtime', () => {
  it('transcribes transferred Float32 audio and correlates the result', async () => {
    const transcriber: WorkerTranscriber = {
      dispose: vi.fn(async () => undefined),
      retry: vi.fn(async () => 'retry'),
      transcribe: vi.fn(async () => '本地转写')
    };
    const responses: AsrWorkerResponse[] = [];
    const handle = createAsrWorkerMessageHandler(transcriber, (response) => responses.push(response));
    const audio = new Float32Array([0.25, -0.5]);

    await handle({ audio: audio.buffer, mode: 'quality', requestId: 'request-1', type: 'transcribe' });

    expect(transcriber.transcribe).toHaveBeenCalledWith(new Float32Array([0.25, -0.5]), 'quality');
    expect(responses).toEqual([{ requestId: 'request-1', text: '本地转写', type: 'result' }]);
  });

  it('supports retry and disposal messages', async () => {
    const transcriber: WorkerTranscriber = {
      dispose: vi.fn(async () => undefined),
      retry: vi.fn(async () => '恢复成功'),
      transcribe: vi.fn(async () => 'unused')
    };
    const responses: AsrWorkerResponse[] = [];
    const handle = createAsrWorkerMessageHandler(transcriber, (response) => responses.push(response));

    await handle({ requestId: 'retry-1', type: 'retry' });
    await handle({ requestId: 'dispose-1', type: 'dispose' });

    expect(responses).toEqual([
      { requestId: 'retry-1', text: '恢复成功', type: 'result' },
      { requestId: 'dispose-1', type: 'disposed' }
    ]);
  });

  it('returns a safe correlated error for invalid requests and inference failures', async () => {
    const transcriber: WorkerTranscriber = {
      dispose: vi.fn(async () => undefined),
      retry: vi.fn(async () => { throw new Error('ONNX failed'); }),
      transcribe: vi.fn(async () => 'unused')
    };
    const responses: AsrWorkerResponse[] = [];
    const handle = createAsrWorkerMessageHandler(transcriber, (response) => responses.push(response));

    await handle({ requestId: 'retry-error', type: 'retry' });
    await handle({ requestId: 'bad', type: 'unknown' } as never);

    expect(responses).toEqual([
      { message: 'ONNX failed', requestId: 'retry-error', type: 'error' },
      { message: 'Invalid ASR worker request.', requestId: 'bad', type: 'error' }
    ]);
  });
});
