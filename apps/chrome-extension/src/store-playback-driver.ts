import type { PlaybackDriver, PlaybackResult } from './playback-driver.js';
import type { TargetSession } from './target-session.js';

type SendToDocument = (
  tabId: number,
  message: unknown,
  options: { documentId: string; frameId: number }
) => Promise<unknown>;

export type StorePlaybackDriverOptions = {
  send?: SendToDocument;
};

export class StorePlaybackDriver implements PlaybackDriver {
  private readonly send: SendToDocument;

  constructor(options: StorePlaybackDriverOptions = {}) {
    this.send = options.send ?? ((tabId, message, sendOptions) => (
      chrome.tabs.sendMessage(tabId, message, sendOptions)
    ));
  }

  async play(session: TargetSession): Promise<PlaybackResult> {
    const target = session.target;
    if (!target || target.documentId !== session.documentId || target.frameId !== session.frameId) {
      return { status: 'failed', code: 'TARGET_NAVIGATED' };
    }
    if (target.kind !== 'html-media' || !target.canDirectPlay) {
      const code = target.kind === 'embedded-player'
        ? 'EMBEDDED_PLAYER_CLICK_REQUIRED'
        : 'USER_PLAY_REQUIRED';
      try {
        await this.sendToTarget(session, 'playback:prompt');
      } catch {
        return { status: 'failed', code: 'TARGET_NAVIGATED' };
      }
      return { status: 'user-play-required', code };
    }

    try {
      const value = await this.sendToTarget(session, 'playback:play');
      return parsePlaybackResult(value);
    } catch {
      return { status: 'failed', code: 'TARGET_NAVIGATED' };
    }
  }

  async pause(session: TargetSession): Promise<void> {
    if (!session.target || session.target.kind !== 'html-media') return;
    await this.sendToTarget(session, 'playback:pause');
  }

  async dispose(session: TargetSession): Promise<void> {
    if (!session.target) return;
    try {
      await this.sendToTarget(session, 'playback:dispose');
    } catch {
      // Disposal is idempotent even if the exact document has already gone.
    }
  }

  private sendToTarget(session: TargetSession, type: string): Promise<unknown> {
    const target = session.target;
    if (!target) throw new Error('Voice VAC target is missing.');
    return this.send(session.tabId, {
      target: 'content-tunnel',
      type,
      sessionId: session.id,
      targetId: target.id
    }, {
      documentId: session.documentId,
      frameId: session.frameId
    });
  }
}

function parsePlaybackResult(value: unknown): PlaybackResult {
  if (!isRecord(value)) return { status: 'failed', code: 'NO_PLAYABLE_MEDIA' };
  if (value.status === 'playing' && Object.keys(value).length === 1) {
    return { status: 'playing' };
  }
  if (
    value.status === 'user-play-required'
    && (value.code === 'USER_PLAY_REQUIRED' || value.code === 'EMBEDDED_PLAYER_CLICK_REQUIRED')
    && Object.keys(value).length === 2
  ) {
    return { status: value.status, code: value.code };
  }
  if (value.status === 'failed' && isPlaybackFailureCode(value.code) && Object.keys(value).length === 2) {
    return { status: value.status, code: value.code };
  }
  return { status: 'failed', code: 'NO_PLAYABLE_MEDIA' };
}

function isPlaybackFailureCode(value: unknown): value is 'NO_PLAYABLE_MEDIA' | 'TARGET_NAVIGATED' {
  return value === 'NO_PLAYABLE_MEDIA' || value === 'TARGET_NAVIGATED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
