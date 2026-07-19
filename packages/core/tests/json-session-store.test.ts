import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { JsonSessionStore } from '../src/json-session-store.js';
import { VoivoxService } from '../src/voivox-service.js';

describe('JsonSessionStore', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    temporaryDirectories.forEach((directory) => rmSync(directory, { force: true, recursive: true }));
  });

  it('restores completed source text but never resumes a capture after an app restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voivox-store-'));
    temporaryDirectories.push(directory);
    const store = new JsonSessionStore(join(directory, 'sessions.json'));
    const firstRun = new VoivoxService(() => new Date('2026-07-16T01:00:00.000Z'), store);
    const session = firstRun.startCapture({ kind: 'macos-process', label: 'Safari' });
    firstRun.appendRawSegment(session.id, { startMs: 0, endMs: 500, text: '保留在本机。' });

    const restarted = new VoivoxService(() => new Date('2026-07-16T02:00:00.000Z'), store);

    expect(restarted.getActiveSession()).toBeUndefined();
    expect(restarted.getSession(session.id)).toMatchObject({
      status: 'interrupted',
      revision: 2,
      rawSegments: [{ text: '保留在本机。' }]
    });
    expect(restarted.changesSince(session.id, 0)).toMatchObject({
      revision: 2,
      status: 'interrupted',
      appendedSegments: [{ text: '保留在本机。' }]
    });
    expect(restarted.changesSince(session.id, 1)).toMatchObject({
      revision: 2,
      status: 'interrupted',
      appendedSegments: []
    });
  });

  it('atomically replaces the current snapshot without depending on a shared temp path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'voivox-store-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'sessions.json');
    mkdirSync(`${filePath}.tmp`);
    const store = new JsonSessionStore(filePath);

    store.save([]);

    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual([]);
  });
});
