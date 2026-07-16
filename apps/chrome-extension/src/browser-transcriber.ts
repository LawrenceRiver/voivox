import {
  browserModelForMode,
  type TranscriptionMode
} from './local-transcription.js';

export type PipelineProgress = {
  file?: string;
  loaded?: number;
  progress?: number;
  status: string;
  total?: number;
};

export type SpeechRecognitionPipeline = {
  (audio: Float32Array): Promise<{ text: string }>;
  dispose(): Promise<void> | void;
};

export type PipelineFactory = (
  task: 'automatic-speech-recognition',
  modelId: string,
  options: {
    dtype: 'q8';
    progress_callback: (progress: PipelineProgress) => void;
    revision: string;
  }
) => Promise<SpeechRecognitionPipeline>;

export type BrowserTranscriberState =
  | { phase: 'idle' }
  | { mode: TranscriptionMode; phase: 'downloading'; progress: number }
  | { mode: TranscriptionMode; phase: 'transcribing' }
  | { mode: TranscriptionMode; phase: 'complete'; text: string }
  | { canRetry: true; message: string; mode: TranscriptionMode; phase: 'error' };

type DownloadFileState = {
  loaded?: number;
  progress: number;
  total?: number;
};

type ActiveDownload = {
  files: Map<string, DownloadFileState>;
  generation: number;
  mode: TranscriptionMode;
  progress: number;
};

export class BrowserTranscriber {
  private activeDownload?: ActiveDownload;
  private currentState: BrowserTranscriberState = { phase: 'idle' };
  private disposalRequested = false;
  private failedRequest?: { audio: Float32Array; mode: TranscriptionMode };
  private loadedMode?: TranscriptionMode;
  private pipeline?: SpeechRecognitionPipeline;
  private queuedTranscriptions = 0;
  private queue: Promise<void> = Promise.resolve();
  private retryInFlight?: Promise<string>;
  private nextLoadGeneration = 0;

  constructor(
    private readonly createPipeline: PipelineFactory,
    private readonly onStateChange: (state: BrowserTranscriberState) => void = () => undefined
  ) {}

  get state(): BrowserTranscriberState {
    return this.currentState;
  }

  private publish(state: BrowserTranscriberState): void {
    this.currentState = state;
    try {
      this.onStateChange(state);
    } catch {
      // UI observers are not part of the model execution path.
    }
  }

  private reportDownloadProgress(generation: number, event: PipelineProgress): void {
    const download = this.activeDownload;
    if (!download || download.generation !== generation) {
      return;
    }

    const file = event.file ?? '__model__';
    const previous = download.files.get(file);
    const total = Number.isFinite(event.total) && (event.total ?? 0) > 0
      ? event.total
      : previous?.total;
    const reportedLoaded = Number.isFinite(event.loaded) && (event.loaded ?? 0) >= 0
      ? event.loaded
      : undefined;
    const reportedProgress = Number.isFinite(event.progress)
      ? Math.min(100, Math.max(0, event.progress ?? 0))
      : undefined;
    let loaded = reportedLoaded === undefined
      ? previous?.loaded
      : Math.max(previous?.loaded ?? 0, reportedLoaded);
    let progress = reportedProgress ?? previous?.progress ?? 0;

    if (event.status === 'done') {
      progress = 100;
      loaded = total ?? loaded;
    } else if (total !== undefined && loaded !== undefined) {
      progress = (loaded / total) * 100;
    } else if (total !== undefined && reportedProgress !== undefined) {
      loaded = (reportedProgress / 100) * total;
    }

    download.files.set(file, {
      loaded,
      progress: Math.max(previous?.progress ?? 0, Math.min(100, progress)),
      total
    });

    const files = [...download.files.values()];
    const hasBytesForEveryFile = files.every((entry) => (
      entry.loaded !== undefined && entry.total !== undefined
    ));
    const aggregate = hasBytesForEveryFile
      ? (files.reduce((sum, entry) => sum + (entry.loaded ?? 0), 0)
        / files.reduce((sum, entry) => sum + (entry.total ?? 0), 0)) * 100
      : files.reduce((sum, entry) => sum + entry.progress, 0) / files.length;
    const monotonicProgress = Math.max(
      download.progress,
      Math.min(100, Math.max(0, aggregate))
    );

    if (monotonicProgress > download.progress) {
      download.progress = monotonicProgress;
      this.publish({
        mode: download.mode,
        phase: 'downloading',
        progress: monotonicProgress
      });
    }
  }

  transcribe(audio: Float32Array, mode: TranscriptionMode): Promise<string> {
    if (this.disposalRequested) {
      return Promise.reject(new Error('BrowserTranscriber has been disposed.'));
    }
    if (this.queuedTranscriptions >= 2) {
      return Promise.reject(new Error('Transcription queue is full.'));
    }

    this.queuedTranscriptions += 1;
    const result = this.queue.then(async () => {
      try {
        if (this.disposalRequested) {
          throw new Error('BrowserTranscriber has been disposed.');
        }
        return await this.runTranscription(audio, mode);
      } finally {
        this.queuedTranscriptions -= 1;
      }
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  retry(): Promise<string> {
    if (this.retryInFlight) {
      return this.retryInFlight;
    }
    if (!this.failedRequest) {
      return Promise.reject(new Error('There is no failed transcription to retry.'));
    }
    const retry = this.transcribe(this.failedRequest.audio, this.failedRequest.mode);
    this.retryInFlight = retry;
    const clearRetry = () => {
      if (this.retryInFlight === retry) {
        this.retryInFlight = undefined;
      }
    };
    void retry.then(clearRetry, clearRetry);
    return retry;
  }

  dispose(): Promise<void> {
    this.disposalRequested = true;
    this.activeDownload = undefined;
    const result = this.queue.then(async () => {
      const pipeline = this.pipeline;
      this.pipeline = undefined;
      this.loadedMode = undefined;
      this.failedRequest = undefined;
      try {
        await pipeline?.dispose();
      } finally {
        this.publish({ phase: 'idle' });
      }
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async runTranscription(audio: Float32Array, mode: TranscriptionMode): Promise<string> {
    try {
      if (this.pipeline && this.loadedMode !== mode) {
        const pipeline = this.pipeline;
        this.pipeline = undefined;
        this.loadedMode = undefined;
        await pipeline.dispose();
      }

      if (!this.pipeline) {
        const model = browserModelForMode(mode);
        const generation = ++this.nextLoadGeneration;
        this.activeDownload = {
          files: new Map(),
          generation,
          mode,
          progress: 0
        };
        this.publish({ mode, phase: 'downloading', progress: 0 });
        try {
          this.pipeline = await this.createPipeline(
            'automatic-speech-recognition',
            model.id,
            {
              dtype: model.dtype,
              progress_callback: (event) => {
                this.reportDownloadProgress(generation, event);
              },
              revision: model.revision
            }
          );
        } finally {
          if (this.activeDownload?.generation === generation) {
            this.activeDownload = undefined;
          }
        }
        this.loadedMode = mode;
      }

      this.publish({ mode, phase: 'transcribing' });
      const text = (await this.pipeline(audio)).text.trim();
      this.failedRequest = undefined;
      this.publish({ mode, phase: 'complete', text });
      return text;
    } catch (error) {
      this.failedRequest = { audio, mode };
      this.publish({
        canRetry: true,
        message: error instanceof Error ? error.message : String(error),
        mode,
        phase: 'error'
      });
      throw error;
    }
  }
}
