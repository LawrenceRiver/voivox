import type { TranscriptionMode } from './local-transcription.js';

export type AsrWorkerRequest =
  | { audio: ArrayBuffer; mode: TranscriptionMode; requestId: string; type: 'transcribe' }
  | { requestId: string; type: 'retry' }
  | { requestId: string; type: 'dispose' };

export type AsrWorkerResponse =
  | { requestId: string; text: string; type: 'result' }
  | { requestId: string; type: 'disposed' }
  | { message: string; requestId: string; type: 'error' };

export type WorkerTranscriber = {
  dispose(): Promise<void>;
  retry(): Promise<string>;
  transcribe(audio: Float32Array, mode: TranscriptionMode): Promise<string>;
};

export function createAsrWorkerMessageHandler(
  transcriber: WorkerTranscriber,
  post: (response: AsrWorkerResponse) => void
): (request: AsrWorkerRequest) => Promise<void> {
  return async (request) => {
    const requestId = readRequestId(request);
    try {
      if (isTranscribeRequest(request)) {
        const text = await transcriber.transcribe(new Float32Array(request.audio), request.mode);
        post({ requestId, text, type: 'result' });
        return;
      }
      if (isSimpleRequest(request, 'retry')) {
        post({ requestId, text: await transcriber.retry(), type: 'result' });
        return;
      }
      if (isSimpleRequest(request, 'dispose')) {
        await transcriber.dispose();
        post({ requestId, type: 'disposed' });
        return;
      }
      throw new Error('Invalid ASR worker request.');
    } catch (error) {
      post({
        message: error instanceof Error ? error.message : 'Browser-local transcription failed.',
        requestId,
        type: 'error'
      });
    }
  };
}

function readRequestId(request: unknown): string {
  if (
    typeof request === 'object'
    && request !== null
    && 'requestId' in request
    && typeof request.requestId === 'string'
    && request.requestId.length > 0
  ) {
    return request.requestId;
  }
  return 'unknown';
}

function isTranscribeRequest(request: unknown): request is Extract<AsrWorkerRequest, { type: 'transcribe' }> {
  return typeof request === 'object'
    && request !== null
    && 'type' in request
    && request.type === 'transcribe'
    && 'requestId' in request
    && typeof request.requestId === 'string'
    && request.requestId.length > 0
    && 'mode' in request
    && (request.mode === 'fast' || request.mode === 'quality')
    && 'audio' in request
    && request.audio instanceof ArrayBuffer
    && request.audio.byteLength > 0
    && request.audio.byteLength % Float32Array.BYTES_PER_ELEMENT === 0;
}

function isSimpleRequest<T extends 'retry' | 'dispose'>(
  request: unknown,
  type: T
): request is Extract<AsrWorkerRequest, { type: T }> {
  return typeof request === 'object'
    && request !== null
    && 'type' in request
    && request.type === type
    && 'requestId' in request
    && typeof request.requestId === 'string'
    && request.requestId.length > 0;
}
