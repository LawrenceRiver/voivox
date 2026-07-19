export type TranscriptionMode = 'auto' | 'live' | 'accelerated';

export type ProcessingMode = 'live_tunnel' | 'accelerated_batch';

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptResult = {
  status: 'completed';
  source_url?: string;
  title: string;
  language: string;
  duration_seconds?: number;
  processing_mode: ProcessingMode;
  transcript: string;
  segments: TranscriptSegment[];
};

export type TranscriptResultInput = Omit<TranscriptResult, 'status'> & {
  status?: 'completed';
};

export function createTranscriptResult(input: TranscriptResultInput): TranscriptResult {
  const result: TranscriptResult = {
    status: 'completed',
    ...(input.source_url ? { source_url: input.source_url } : {}),
    title: input.title,
    language: input.language,
    ...(input.duration_seconds === undefined ? {} : { duration_seconds: input.duration_seconds }),
    processing_mode: input.processing_mode,
    transcript: input.transcript,
    segments: input.segments.map((segment) => ({ ...segment }))
  };
  return validateTranscriptResult(result);
}

export function validateTranscriptResult(value: unknown): TranscriptResult {
  if (!isRecord(value)
    || value.status !== 'completed'
    || typeof value.title !== 'string'
    || value.title.trim() === ''
    || typeof value.language !== 'string'
    || value.language.trim() === ''
    || (value.source_url !== undefined && !isHttpUrl(value.source_url))
    || (value.duration_seconds !== undefined && !isNonNegativeFiniteNumber(value.duration_seconds))
    || (value.processing_mode !== 'live_tunnel' && value.processing_mode !== 'accelerated_batch')
    || typeof value.transcript !== 'string'
    || value.transcript.trim() === ''
    || !Array.isArray(value.segments)) {
    throw new Error('Invalid PVTT transcript result');
  }

  let previousEnd = 0;
  const segments: TranscriptSegment[] = [];
  for (const segment of value.segments) {
    if (!isRecord(segment)
      || !isNonNegativeFiniteNumber(segment.start)
      || !isNonNegativeFiniteNumber(segment.end)
      || segment.end <= segment.start
      || segment.start < previousEnd
      || typeof segment.text !== 'string'
      || segment.text.trim() === '') {
      throw new Error('Invalid PVTT transcript result');
    }
    previousEnd = segment.end;
    segments.push({ start: segment.start, end: segment.end, text: segment.text });
  }

  return {
    status: 'completed',
    ...(value.source_url === undefined ? {} : { source_url: value.source_url }),
    title: value.title,
    language: value.language,
    ...(value.duration_seconds === undefined ? {} : { duration_seconds: value.duration_seconds }),
    processing_mode: value.processing_mode,
    transcript: value.transcript,
    segments
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
