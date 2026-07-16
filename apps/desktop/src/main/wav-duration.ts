import { open } from 'node:fs/promises';

export async function readWavDuration(audioPath: string): Promise<number | undefined> {
  const handle = await open(audioPath, 'r');
  try {
    const header = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return durationFromWavHeader(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function durationFromWavHeader(header: Uint8Array): number | undefined {
  const view = Buffer.from(header);
  if (view.length < 12 || view.toString('ascii', 0, 4) !== 'RIFF' || view.toString('ascii', 8, 12) !== 'WAVE') {
    return undefined;
  }

  let byteRate: number | undefined;
  let dataSize: number | undefined;
  let offset = 12;
  while (offset + 8 <= view.length) {
    const id = view.toString('ascii', offset, offset + 4);
    const chunkSize = view.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (id === 'fmt ' && chunkSize >= 16 && dataOffset + 16 <= view.length) {
      byteRate = view.readUInt32LE(dataOffset + 8);
    }
    if (id === 'data') {
      dataSize = chunkSize;
    }
    if (byteRate && dataSize !== undefined) {
      return Math.round((dataSize / byteRate) * 1_000);
    }
    offset = dataOffset + chunkSize + (chunkSize % 2);
  }
  return undefined;
}
