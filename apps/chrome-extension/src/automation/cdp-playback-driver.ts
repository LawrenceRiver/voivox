import type { PlaybackDriver, PlaybackResult } from '../playback-driver.js';
import type { TargetSession } from '../target-session.js';

type DebuggerApi = {
  attach(target: chrome.debugger.Debuggee, requiredVersion: string): Promise<void>;
  detach(target: chrome.debugger.Debuggee): Promise<void>;
  sendCommand(
    target: chrome.debugger.Debuggee,
    method: string,
    commandParams?: object
  ): Promise<unknown>;
  onDetach: {
    addListener(listener: (source: chrome.debugger.Debuggee, reason: string) => void): void;
  };
};

export type CdpPlaybackDriverOptions = {
  api?: DebuggerApi;
  onUnexpectedDetach?: (tabId: number, code: 'DEBUGGER_DETACHED') => void;
};

export class CdpPlaybackDriver implements PlaybackDriver {
  private readonly api: DebuggerApi;
  private readonly attachedTabs = new Set<number>();
  private readonly unexpectedlyDetachedTabs = new Set<number>();
  private readonly onUnexpectedDetach?: CdpPlaybackDriverOptions['onUnexpectedDetach'];

  constructor(options: CdpPlaybackDriverOptions = {}) {
    this.api = options.api ?? chrome.debugger;
    this.onUnexpectedDetach = options.onUnexpectedDetach;
    this.api.onDetach.addListener((source) => {
      const tabId = source.tabId;
      if (tabId === undefined || !this.attachedTabs.delete(tabId)) return;
      this.unexpectedlyDetachedTabs.add(tabId);
      this.onUnexpectedDetach?.(tabId, 'DEBUGGER_DETACHED');
    });
  }

  async play(session: TargetSession): Promise<PlaybackResult> {
    const target = session.target;
    if (!target || target.documentId !== session.documentId || target.frameId !== session.frameId) {
      return { status: 'failed', code: 'TARGET_NAVIGATED' };
    }
    if (this.unexpectedlyDetachedTabs.has(session.tabId)) {
      return { status: 'failed', code: 'DEBUGGER_DETACHED' };
    }
    if (!await this.ensureAttached(session.tabId)) {
      return { status: 'failed', code: 'DEBUGGER_ATTACH_FAILED' };
    }

    if (target.kind === 'html-media') return this.evaluateMedia(session, 'play');
    try {
      const source = { tabId: session.tabId };
      const { x, y } = target.activationPoint;
      await this.api.sendCommand(source, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await this.api.sendCommand(source, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1
      });
      await this.api.sendCommand(source, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
      });
      return { status: 'playing' };
    } catch {
      return { status: 'failed', code: 'DEBUGGER_DETACHED' };
    }
  }

  async pause(session: TargetSession): Promise<void> {
    if (!session.target || session.target.kind !== 'html-media') return;
    const result = await this.evaluateMedia(session, 'pause');
    if (result.status === 'failed') throw new Error(result.code);
  }

  async dispose(session: TargetSession): Promise<void> {
    const tabId = session.tabId;
    this.unexpectedlyDetachedTabs.delete(tabId);
    if (!this.attachedTabs.delete(tabId)) return;
    try {
      await this.api.detach({ tabId });
    } catch {
      // Chrome may have detached first; the local lifecycle is already clean.
    }
  }

  private async ensureAttached(tabId: number): Promise<boolean> {
    if (this.attachedTabs.has(tabId)) return true;
    try {
      await this.api.attach({ tabId }, '1.3');
      this.attachedTabs.add(tabId);
      return true;
    } catch {
      return false;
    }
  }

  private async evaluateMedia(
    session: TargetSession,
    operation: 'play' | 'pause'
  ): Promise<PlaybackResult> {
    const id = session.target?.id;
    if (!id) return { status: 'failed', code: 'TARGET_NAVIGATED' };
    const expression = mediaExpression(id, operation);
    try {
      const response = await this.api.sendCommand(
        { tabId: session.tabId },
        'Runtime.evaluate',
        {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true
        }
      ) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (response.exceptionDetails) return { status: 'failed', code: 'NO_PLAYABLE_MEDIA' };
      return parseCdpResult(response.result?.value);
    } catch {
      return { status: 'failed', code: 'DEBUGGER_DETACHED' };
    }
  }
}

function mediaExpression(id: string, operation: 'play' | 'pause'): string {
  const encodedId = JSON.stringify(id);
  if (operation === 'pause') {
    return `(() => { const id = ${encodedId}; const media = [...document.querySelectorAll('video,audio')].find((node) => node.getAttribute('data-voice-vac-target-id') === id); if (!media) return { status: 'failed', code: 'TARGET_NAVIGATED' }; media.pause(); return { status: 'playing' }; })()`;
  }
  return `(() => { const id = ${encodedId}; const media = [...document.querySelectorAll('video,audio')].find((node) => node.getAttribute('data-voice-vac-target-id') === id); if (!media) return { status: 'failed', code: 'TARGET_NAVIGATED' }; return media.play().then(() => ({ status: 'playing' }), () => ({ status: 'failed', code: 'NO_PLAYABLE_MEDIA' })); })()`;
}

function parseCdpResult(value: unknown): PlaybackResult {
  if (!isRecord(value)) return { status: 'failed', code: 'NO_PLAYABLE_MEDIA' };
  if (value.status === 'playing' && Object.keys(value).length === 1) return { status: 'playing' };
  if (
    value.status === 'failed'
    && (value.code === 'TARGET_NAVIGATED' || value.code === 'NO_PLAYABLE_MEDIA')
    && Object.keys(value).length === 2
  ) {
    return { status: 'failed', code: value.code };
  }
  return { status: 'failed', code: 'NO_PLAYABLE_MEDIA' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
