import type { CaptureSession } from './voivox-service.js';

export interface SessionStore {
  load(): CaptureSession[];
  save(sessions: CaptureSession[]): void;
}
