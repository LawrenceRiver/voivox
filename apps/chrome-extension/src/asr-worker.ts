import { createAsrWorkerMessageHandler, type AsrWorkerRequest } from './asr-worker-runtime.js';
import { BrowserTranscriber } from './browser-transcriber.js';
import { createTransformersPipelineFactory } from './transformers-pipeline.js';

type WorkerScope = {
  location: Location;
  onmessage: ((event: MessageEvent<AsrWorkerRequest>) => void) | null;
  postMessage(message: unknown): void;
};

const worker = globalThis as unknown as WorkerScope;
const createPipeline = createTransformersPipelineFactory({
  wasmBaseUrl: new URL('./wasm/', worker.location.href).href
});
const transcriber = new BrowserTranscriber(createPipeline, (state) => {
  worker.postMessage({ state, type: 'state' });
});
const handleMessage = createAsrWorkerMessageHandler(transcriber, (response) => {
  worker.postMessage(response);
});

worker.onmessage = (event) => {
  void handleMessage(event.data);
};
