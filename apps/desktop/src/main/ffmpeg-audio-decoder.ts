import { spawn } from 'node:child_process';

import type { AcceleratedAudioChunk } from './accelerated-transcriber.js';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

export type DecodedAudio = {
  chunks: AcceleratedAudioChunk[];
  durationSeconds: number;
  sampleRate: 16_000;
  channels: 1;
};

export function chunkPcm16le(
  pcm: Uint8Array,
  options: { chunkSeconds?: number; overlapSeconds?: number } = {}
): AcceleratedAudioChunk[] {
  const chunkBytes = Math.max(2, Math.floor((options.chunkSeconds ?? 30) * SAMPLE_RATE * BYTES_PER_SAMPLE));
  const overlapBytes = Math.max(0, Math.min(chunkBytes - 2, Math.floor((options.overlapSeconds ?? 1) * SAMPLE_RATE * BYTES_PER_SAMPLE)));
  const stepBytes = chunkBytes - overlapBytes;
  const chunks: AcceleratedAudioChunk[] = [];
  for (let offset = 0; offset < pcm.byteLength; offset += stepBytes) {
    const end = Math.min(pcm.byteLength, offset + chunkBytes);
    if (end <= offset) break;
    const alignedEnd = end - ((end - offset) % BYTES_PER_SAMPLE);
    if (alignedEnd <= offset) break;
    chunks.push({
      startMs: Math.round((offset / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1_000),
      endMs: Math.round((alignedEnd / (SAMPLE_RATE * BYTES_PER_SAMPLE)) * 1_000),
      pcm: pcm.slice(offset, alignedEnd)
    });
    if (end === pcm.byteLength) break;
  }
  return chunks;
}

/** Decode an ordinary, locally accessible media file through FFmpeg.
 *
 * This deliberately accepts a local path only. URL acquisition, DRM, and
 * authentication remain outside this helper and must be authorized by the
 * caller before a file is placed on disk.
 */
export async function decodeLocalMediaFile(
  inputPath: string,
  options: { ffmpegPath?: string; chunkSeconds?: number; overlapSeconds?: number } = {}
): Promise<DecodedAudio> {
  if (!inputPath.trim()) throw new Error('A local media path is required for accelerated decode.');
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const pcm = await runFfmpeg(ffmpegPath, inputPath);
  const chunks = chunkPcm16le(pcm, options);
  return {
    channels: 1,
    chunks,
    durationSeconds: pcm.byteLength / (SAMPLE_RATE * BYTES_PER_SAMPLE),
    sampleRate: SAMPLE_RATE
  };
}

function runFfmpeg(ffmpegPath: string, inputPath: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-f', 's16le',
      'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', (error) => reject(new Error(`FFmpeg could not start: ${error.message}`)));
    child.once('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        reject(new Error(`FFmpeg could not decode the media${detail ? `: ${detail}` : '.'}`));
        return;
      }
      resolve(new Uint8Array(Buffer.concat(output)));
    });
  });
}
