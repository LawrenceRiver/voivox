import type { CaptureErrorCode } from './capture-errors.js';
import type { TargetSession } from './target-session.js';

export type PlaybackResult =
  | { status: 'playing' }
  | {
      status: 'user-play-required';
      code: 'USER_PLAY_REQUIRED' | 'EMBEDDED_PLAYER_CLICK_REQUIRED';
    }
  | { status: 'failed'; code: CaptureErrorCode };

export interface PlaybackDriver {
  play(session: TargetSession): Promise<PlaybackResult>;
  pause(session: TargetSession): Promise<void>;
  dispose(session: TargetSession): Promise<void>;
}
