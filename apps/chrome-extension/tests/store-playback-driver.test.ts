import { describe, expect, it, vi } from 'vitest';

import { StorePlaybackDriver } from '../src/store-playback-driver.js';
import type { TargetSession, VideoTarget } from '../src/target-session.js';

describe('StorePlaybackDriver', () => {
  it('plays only the exact media in the fixed armed document', async () => {
    const send = vi.fn(async () => ({ status: 'playing' }));
    const driver = new StorePlaybackDriver({ send });

    await expect(driver.play(readySession())).resolves.toEqual({ status: 'playing' });
    expect(send).toHaveBeenCalledWith(41, {
      target: 'content-tunnel',
      type: 'playback:play',
      sessionId: SESSION_ID,
      targetId: TARGET_ID
    }, { documentId: 'doc-41', frameId: 0 });
  });

  it('maps autoplay rejection to a trusted user-play prompt', async () => {
    const send = vi.fn(async () => ({
      status: 'user-play-required',
      code: 'USER_PLAY_REQUIRED'
    }));
    const driver = new StorePlaybackDriver({ send });

    await expect(driver.play(readySession())).resolves.toEqual({
      status: 'user-play-required',
      code: 'USER_PLAY_REQUIRED'
    });
  });

  it.each([
    ['embedded-player', 'EMBEDDED_PLAYER_CLICK_REQUIRED'],
    ['tab-audio', 'USER_PLAY_REQUIRED']
  ] as const)('never synthesizes a Store click for %s', async (kind, code) => {
    const send = vi.fn(async () => ({ ok: true }));
    const driver = new StorePlaybackDriver({ send });

    await expect(driver.play(readySession({ kind, canDirectPlay: false }))).resolves.toEqual({
      status: 'user-play-required',
      code
    });
    expect(send).toHaveBeenCalledWith(41, {
      target: 'content-tunnel',
      type: 'playback:prompt',
      sessionId: SESSION_ID,
      targetId: TARGET_ID
    }, { documentId: 'doc-41', frameId: 0 });
  });

  it('pauses and disposes only the fixed armed document', async () => {
    const send = vi.fn(async () => ({ ok: true }));
    const driver = new StorePlaybackDriver({ send });
    const session = readySession();

    await driver.pause(session);
    await driver.dispose(session);

    expect(send).toHaveBeenNthCalledWith(1, 41, {
      target: 'content-tunnel',
      type: 'playback:pause',
      sessionId: SESSION_ID,
      targetId: TARGET_ID
    }, { documentId: 'doc-41', frameId: 0 });
    expect(send).toHaveBeenNthCalledWith(2, 41, {
      target: 'content-tunnel',
      type: 'playback:dispose',
      sessionId: SESSION_ID,
      targetId: TARGET_ID
    }, { documentId: 'doc-41', frameId: 0 });
  });

  it('maps a vanished fixed document to TARGET_NAVIGATED', async () => {
    const driver = new StorePlaybackDriver({
      send: vi.fn(async () => { throw new Error('Receiving end does not exist'); })
    });

    await expect(driver.play(readySession())).resolves.toEqual({
      status: 'failed',
      code: 'TARGET_NAVIGATED'
    });
  });
});

const SESSION_ID = '2b0fe529-4021-4674-b55e-1cf081f947dd';
const TARGET_ID = '0f9277ea-8f9a-4e4e-8cf1-af1afcde2e07';

function readySession(targetPatch: Partial<VideoTarget> = {}): TargetSession {
  const target: VideoTarget = {
    id: TARGET_ID,
    kind: 'html-media',
    tag: 'video',
    frameId: 0,
    documentId: 'doc-41',
    viewportRect: { x: 10, y: 20, width: 640, height: 360 },
    screenRect: { x: 110, y: 220, width: 640, height: 360 },
    activationPoint: { x: 320, y: 180 },
    canDirectPlay: true,
    ...targetPatch
  };
  return {
    schemaVersion: 1,
    id: SESSION_ID,
    tabId: 41,
    windowId: 3,
    frameId: 0,
    documentId: 'doc-41',
    pageOrigin: 'https://video.example',
    url: 'https://video.example/watch',
    title: 'Fixed video',
    dropNonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    dropToken: `VOICE_VAC_DROP_V1|${SESSION_ID}|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    status: 'ready',
    target,
    tunnelSessionId: 'tunnel-41',
    armedAt: 1,
    updatedAt: 1
  };
}
