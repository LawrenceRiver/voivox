import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SessionStore } from './session-store.js';
import type { CaptureSession } from './voivox-service.js';

export class JsonSessionStore implements SessionStore {
  constructor(private readonly filePath: string) {}

  load(): CaptureSession[] {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error('VOIVOX session store is malformed.');
    }

    return parsed as CaptureSession[];
  }

  save(sessions: CaptureSession[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(sessions, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}
