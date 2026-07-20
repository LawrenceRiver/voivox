import { describe, expect, it, vi } from 'vitest';

import { CdpPlaybackDriver } from '../src/automation/cdp-playback-driver.js';
import type { TargetSession, VideoTarget } from '../src/target-session.js';

describe('CdpPlaybackDriver', () => {
  it('uses a CDP user gesture to play direct media in the fixed tab', async () => {
    const harness = debuggerHarness();
    const driver = new CdpPlaybackDriver({ api: harness.api });

    await expect(driver.play(readySession())).resolves.toEqual({ status: 'playing' });

    expect(harness.attach).toHaveBeenCalledWith({ tabId: 41 }, '1.3');
    expect(harness.sendCommand).toHaveBeenCalledWith(
      { tabId: 41 },
      'Runtime.evaluate',
      expect.objectContaining({
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      })
    );
  });

  it('dispatches an internal embedded-player click without focusing the tab', async () => {
    const harness = debuggerHarness();
    const driver = new CdpPlaybackDriver({ api: harness.api });

    await expect(driver.play(readySession({
      kind: 'embedded-player',
      canDirectPlay: false,
      activationPoint: { x: 640, y: 360 }
    }))).resolves.toEqual({ status: 'playing' });

    expect(harness.sendCommand.mock.calls.map((call) => call[1])).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent'
    ]);
    expect(harness.sendCommand.mock.calls.map((call) => call[2])).toEqual([
      expect.objectContaining({ type: 'mouseMoved', x: 640, y: 360 }),
      expect.objectContaining({ type: 'mousePressed', button: 'left', clickCount: 1 }),
      expect.objectContaining({ type: 'mouseReleased', button: 'left', clickCount: 1 })
    ]);
    expect(harness.sendCommand.mock.calls.map((call) => call[1])).not.toContain('Page.bringToFront');
    expect(harness.sendCommand.mock.calls.map((call) => call[1])).not.toContain('Target.activateTarget');
  });

  it('attaches once and detaches exactly once across repeated playback and disposal', async () => {
    const harness = debuggerHarness();
    const driver = new CdpPlaybackDriver({ api: harness.api });
    const session = readySession();

    await driver.play(session);
    await driver.play(session);
    await driver.dispose(session);
    await driver.dispose(session);

    expect(harness.attach).toHaveBeenCalledOnce();
    expect(harness.detach).toHaveBeenCalledOnce();
  });

  it('maps attach rejection and an unexpected detach to stable errors', async () => {
    const failed = debuggerHarness({ attachError: true });
    const first = new CdpPlaybackDriver({ api: failed.api });
    await expect(first.play(readySession())).resolves.toEqual({
      status: 'failed',
      code: 'DEBUGGER_ATTACH_FAILED'
    });

    const detached = debuggerHarness();
    const onUnexpectedDetach = vi.fn();
    const second = new CdpPlaybackDriver({ api: detached.api, onUnexpectedDetach });
    await second.play(readySession());
    detached.emitDetach({ tabId: 41 }, 'canceled_by_user');
    expect(onUnexpectedDetach).toHaveBeenCalledWith(41, 'DEBUGGER_DETACHED');
    await expect(second.play(readySession())).resolves.toEqual({
      status: 'failed',
      code: 'DEBUGGER_DETACHED'
    });
  });
});

function debuggerHarness(options: { attachError?: boolean } = {}) {
  const detachListeners: Array<(source: chrome.debugger.Debuggee, reason: string) => void> = [];
  const attach = vi.fn(async () => {
    if (options.attachError) throw new Error('attach failed');
  });
  const detach = vi.fn(async () => undefined);
  const sendCommand = vi.fn(async (_target, method: string, _params?: unknown) => (
    method === 'Runtime.evaluate'
      ? { result: { value: { status: 'playing' } } }
      : {}
  ));
  return {
    api: {
      attach,
      detach,
      sendCommand,
      onDetach: {
        addListener: (listener: (source: chrome.debugger.Debuggee, reason: string) => void) => {
          detachListeners.push(listener);
        }
      }
    },
    attach,
    detach,
    sendCommand,
    emitDetach: (source: chrome.debugger.Debuggee, reason: string) => {
      for (const listener of detachListeners) listener(source, reason);
    }
  };
}

const SESSION_ID = '2b0fe529-4021-4674-b55e-1cf081f947dd';

function readySession(targetPatch: Partial<VideoTarget> = {}): TargetSession {
  const target: VideoTarget = {
    id: '0f9277ea-8f9a-4e4e-8cf1-af1afcde2e07',
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
