// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mountContentTunnel,
  registerContentTunnelRuntime
} from '../src/content-tunnel.js';
import { formatDropToken } from '../src/drop-protocol.js';
import type { TargetSession } from '../src/target-session.js';

const SESSION_ID = '2b0fe529-4021-4674-b55e-1cf081f947dd';
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DROP_TOKEN = formatDropToken(SESSION_ID, NONCE);
const TARGET_ID = '0f9277ea-8f9a-4e4e-8cf1-af1afcde2e07';
const SECOND_SESSION_ID = 'ca84db30-5c2e-46dd-b28c-246e13367dd5';
const SECOND_NONCE = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const SECOND_DROP_TOKEN = formatDropToken(SECOND_SESSION_ID, SECOND_NONCE);
const RUNTIME_MARKER = Symbol.for('com.voice-vac.content-tunnel-runtime.v1');

afterEach(() => {
  document.querySelectorAll('#vacvox-tunnel-root').forEach((element) => element.remove());
  delete document.documentElement.dataset.voiceVacContentTunnelRuntimeV1;
  delete (window as unknown as Record<symbol, unknown>)[RUNTIME_MARKER];
  delete (window as unknown as Record<string, unknown>).voiceVacContentTunnelRuntimeV1;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Voice VAC armed page drop tunnel', () => {
  it('accepts one trusted exact-token drop only while the matching session is dragging', async () => {
    const video = visibleElement('video', rect(40, 50, 640, 360));
    const harness = createHarness([video]);
    harness.tunnel.configure(armedSession());
    expect(harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN })).toBe(true);
    const event = harness.drop({ text: DROP_TOKEN, trusted: true });

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(harness.catcher()?.classList.contains('is-active')).toBe(true);
    await flushMicrotasks();
    expect(harness.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      target: 'service-worker',
      type: 'target:ready',
      sessionId: SESSION_ID,
      videoTarget: expect.objectContaining({
        id: TARGET_ID,
        kind: 'html-media',
        documentId: 'doc-main',
        frameId: 0
      })
    }));
    expect(video.getAttribute('data-voice-vac-target-id')).toBe(TARGET_ID);
    expect(video.classList.contains('voice-vac-target-outline')).toBe(true);
    expect(harness.catcher()?.classList.contains('is-active')).toBe(false);
  });

  it.each([
    ['untrusted drop', { configure: true, begin: 'matching', text: DROP_TOKEN, trusted: false }],
    ['wrong token', { configure: true, begin: 'matching', text: formatDropToken(SESSION_ID, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'), trusted: true }],
    ['wrong drag session', { configure: true, begin: 'wrong-session', text: DROP_TOKEN, trusted: true }],
    ['wrong drag token', { configure: true, begin: 'wrong-token', text: DROP_TOKEN, trusted: true }],
    ['no drag begin', { configure: true, begin: 'none', text: DROP_TOKEN, trusted: true }]
  ] as const)('ignores %s without cancelling the page drop', (_label, scenario) => {
    const video = visibleElement('video', rect(40, 50, 640, 360));
    const harness = createHarness([video]);
    if (scenario.configure) harness.tunnel.configure(armedSession());
    if (scenario.begin === 'matching') {
      harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });
    } else if (scenario.begin === 'wrong-session') {
      expect(harness.tunnel.beginDrag({ sessionId: 'b24f9360-9f19-4e1e-8000-5e5f6f98bf77', dropToken: DROP_TOKEN })).toBe(false);
    } else if (scenario.begin === 'wrong-token') {
      expect(harness.tunnel.beginDrag({
        sessionId: SESSION_ID,
        dropToken: formatDropToken(SESSION_ID, 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')
      })).toBe(false);
    }
    const event = harness.drop({ text: scenario.text, trusted: scenario.trusted });

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(harness.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'target:ready' }));
    expect(harness.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'target:rejected' }));
    expect(video.hasAttribute('data-voice-vac-target-id')).toBe(false);
  });

  it('prevents dragover only for text/plain during a bounded matching drag and publishes a preview', async () => {
    const video = visibleElement('video', rect(40, 50, 640, 360));
    const harness = createHarness([video]);
    harness.tunnel.configure(armedSession());

    const before = harness.dragover(['text/plain']);
    document.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });
    const wrongType = harness.dragover(['text/uri-list']);
    document.dispatchEvent(wrongType);
    expect(wrongType.defaultPrevented).toBe(false);

    const active = harness.dragover(['text/plain']);
    document.dispatchEvent(active);
    expect(active.defaultPrevented).toBe(true);
    await flushMicrotasks();
    expect(harness.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      target: 'service-worker',
      type: 'target:preview',
      sessionId: SESSION_ID,
      videoTarget: expect.objectContaining({ kind: 'html-media' })
    }));
  });

  it('coalesces queued previews so only the latest target follows an in-flight preview', async () => {
    const first = visibleElement('video', rect(40, 50, 640, 360));
    const second = visibleElement('video', rect(80, 90, 720, 405));
    const latest = visibleElement('video', rect(120, 130, 800, 450));
    const harness = createHarness([first]);
    const firstAck = deferred<unknown>();
    let previewCount = 0;
    harness.sendMessage.mockImplementation((message: unknown) => {
      if (messageType(message) === 'target:preview' && previewCount++ === 0) {
        return firstAck.promise;
      }
      return Promise.resolve({ ok: true });
    });
    harness.tunnel.configure(armedSession());
    harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });

    document.dispatchEvent(harness.dragover(['text/plain']));
    await flushMicrotasks();
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);

    harness.setElements([second]);
    document.dispatchEvent(harness.dragover(['text/plain']));
    harness.setElements([latest]);
    document.dispatchEvent(harness.dragover(['text/plain']));
    await flushMicrotasks();
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);

    firstAck.resolve({ ok: true });
    await flushMicrotasks();

    expect(harness.sendMessage).toHaveBeenCalledTimes(2);
    expect(harness.sendMessage.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      type: 'target:preview',
      targetRect: expect.objectContaining({ x: 1120, y: 630, width: 800, height: 450 })
    }));
  });

  it('serializes ready behind preview and commits only after the ready acknowledgement', async () => {
    const video = visibleElement('video', rect(40, 50, 640, 360));
    const harness = createHarness([video]);
    const previewAck = deferred<unknown>();
    const readyAck = deferred<unknown>();
    harness.sendMessage.mockImplementation((message: unknown) => {
      if (messageType(message) === 'target:preview') return previewAck.promise;
      if (messageType(message) === 'target:ready') return readyAck.promise;
      return Promise.resolve({ ok: true });
    });
    harness.tunnel.configure(armedSession());
    harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });

    document.dispatchEvent(harness.dragover(['text/plain']));
    await flushMicrotasks();
    expect(sentMessageTypes(harness.sendMessage)).toEqual(['target:preview']);

    document.dispatchEvent(harness.drop({ text: DROP_TOKEN, trusted: true }));
    await flushMicrotasks();
    expect(sentMessageTypes(harness.sendMessage)).toEqual(['target:preview']);
    expect(harness.catcher()?.classList.contains('is-active')).toBe(true);
    expect(video.hasAttribute('data-voice-vac-target-id')).toBe(false);

    previewAck.resolve({ ok: true });
    await flushMicrotasks();
    expect(sentMessageTypes(harness.sendMessage)).toEqual(['target:preview', 'target:ready']);
    expect(harness.catcher()?.classList.contains('is-active')).toBe(true);

    readyAck.resolve({ ok: true });
    await flushMicrotasks();
    expect(harness.catcher()?.classList.contains('is-active')).toBe(false);
    expect(harness.tunnel.host.dataset.tunnelState).toBe('ready');
  });

  it('keeps the drop catcher armed and shows a stable rejection when ready is not acknowledged', async () => {
    const video = visibleElement('video', rect(40, 50, 640, 360));
    const harness = createHarness([video]);
    let acceptReady = false;
    harness.sendMessage.mockImplementation((message: unknown) => Promise.resolve(
      messageType(message) === 'target:ready'
        ? { ok: acceptReady }
        : { ok: true }
    ));
    harness.tunnel.configure(armedSession());
    harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });

    document.dispatchEvent(harness.drop({ text: DROP_TOKEN, trusted: true }));
    await flushMicrotasks();

    expect(sentMessageTypes(harness.sendMessage)).toEqual(['target:ready', 'target:rejected']);
    expect(harness.catcher()?.classList.contains('is-active')).toBe(true);
    expect(harness.catcher()?.classList.contains('is-rejected')).toBe(true);
    expect(harness.tunnel.host.dataset.tunnelState).toBe('rejected');

    acceptReady = true;
    document.dispatchEvent(harness.drop({ text: DROP_TOKEN, trusted: true }));
    await flushMicrotasks();

    expect(harness.catcher()?.classList.contains('is-active')).toBe(false);
    expect(harness.catcher()?.classList.contains('is-rejected')).toBe(false);
    expect(harness.tunnel.host.dataset.tunnelState).toBe('ready');
  });

  it('fences a delayed ready acknowledgement when a newer session begins dragging', async () => {
    const video = visibleElement('video', rect(40, 50, 640, 360));
    const harness = createHarness([video]);
    const staleReadyAck = deferred<unknown>();
    harness.sendMessage.mockImplementation((message: unknown) => (
      messageType(message) === 'target:ready'
        ? staleReadyAck.promise
        : Promise.resolve({ ok: true })
    ));
    harness.tunnel.configure(armedSession());
    harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });
    document.dispatchEvent(harness.drop({ text: DROP_TOKEN, trusted: true }));
    await flushMicrotasks();

    harness.tunnel.configure(secondArmedSession());
    expect(harness.tunnel.beginDrag({
      sessionId: SECOND_SESSION_ID,
      dropToken: SECOND_DROP_TOKEN
    })).toBe(true);
    staleReadyAck.resolve({ ok: true });
    await flushMicrotasks();

    expect(harness.catcher()?.classList.contains('is-active')).toBe(true);
    expect(harness.tunnel.host.dataset.tunnelState).toBe('dragging');
    expect(harness.tunnel.host.querySelector('.voice-vac-play-prompt')).toBeNull();
  });

  it('reports NO_PLAYABLE_MEDIA and keeps the catcher deployed for another drop', async () => {
    const article = visibleElement('article', rect(10, 10, 500, 300));
    const harness = createHarness([article]);
    harness.tunnel.configure(armedSession());
    harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });
    const rejected = harness.drop({ text: DROP_TOKEN, trusted: true });

    document.dispatchEvent(rejected);

    expect(rejected.defaultPrevented).toBe(true);
    await flushMicrotasks();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      target: 'service-worker',
      type: 'target:rejected',
      sessionId: SESSION_ID,
      error: { code: 'NO_PLAYABLE_MEDIA', retryable: true }
    });
    expect(harness.catcher()?.classList.contains('is-active')).toBe(true);

    const video = visibleElement('video', rect(40, 50, 640, 360));
    harness.setElements([video]);
    const accepted = harness.drop({ text: DROP_TOKEN, trusted: true });
    document.dispatchEvent(accepted);
    await flushMicrotasks();
    expect(accepted.defaultPrevented).toBe(true);
    expect(harness.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'target:ready' }));
  });

  it.each(['iframe', 'section'] as const)(
    'keeps a visible trusted-play prompt for a non-direct %s target',
    async (tag) => {
      const fallback = visibleElement(tag, rect(20, 30, 700, 394));
      if (tag === 'section') fallback.setAttribute('data-video-player', 'true');
      const harness = createHarness([fallback]);
      harness.tunnel.configure(armedSession());
      harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });
      document.dispatchEvent(harness.drop({ text: DROP_TOKEN, trusted: true }));
      await flushMicrotasks();

      const prompt = harness.tunnel.host.querySelector<HTMLButtonElement>('.voice-vac-play-prompt');
      expect(prompt).toBeTruthy();
      expect(prompt?.hidden).toBe(false);
      expect(prompt?.textContent).toContain('Press play once in Chrome.');
      expect(harness.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'target:ready',
        videoTarget: expect.objectContaining({
          kind: tag === 'iframe' ? 'embedded-player' : 'tab-audio',
          canDirectPlay: false
        })
      }));

      prompt?.dispatchEvent(harness.click({ trusted: false }));
      prompt?.dispatchEvent(harness.click({ trusted: true }));
      expect(harness.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'playback:user-started'
      }));
    }
  );

  it('never decorates the full-viewport Voice VAC overlay when an embedded player shares its rect', async () => {
    const bounds = rect(0, 0, 1440, 900);
    const sameSizePageCover = visibleElement('section', bounds);
    const frame = visibleElement('iframe', bounds);
    const harness = createHarness([]);
    const catcher = harness.catcher();
    expect(catcher).toBeTruthy();
    Object.defineProperty(catcher, 'getBoundingClientRect', {
      value: () => ({
        ...bounds,
        top: bounds.y,
        left: bounds.x,
        right: bounds.x + bounds.width,
        bottom: bounds.y + bounds.height,
        toJSON: () => bounds
      })
    });
    harness.setElements([catcher!, sameSizePageCover, frame]);
    harness.tunnel.configure(armedSession());
    harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });

    document.dispatchEvent(harness.drop({ text: DROP_TOKEN, trusted: true }));
    await flushMicrotasks();

    expect(frame.classList.contains('voice-vac-target-outline')).toBe(true);
    expect(sameSizePageCover.classList.contains('voice-vac-target-outline')).toBe(false);
    expect(catcher?.classList.contains('voice-vac-target-outline')).toBe(false);
    harness.tunnel.destroy();
    expect(frame.classList.contains('voice-vac-target-outline')).toBe(false);
  });

  it('decorates the semantic custom player instead of a same-size page cover', async () => {
    const bounds = rect(20, 30, 700, 394);
    const sameSizePageCover = visibleElement('article', bounds);
    const player = visibleElement('section', bounds);
    player.setAttribute('data-video-player', 'true');
    const harness = createHarness([sameSizePageCover, player]);
    harness.tunnel.configure(armedSession());
    harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });

    document.dispatchEvent(harness.drop({ text: DROP_TOKEN, trusted: true }));
    await flushMicrotasks();

    expect(player.classList.contains('voice-vac-target-outline')).toBe(true);
    expect(sameSizePageCover.classList.contains('voice-vac-target-outline')).toBe(false);
  });

  it('restores the page outline value and priority after disconnect', async () => {
    const video = visibleElement('video', rect(40, 50, 640, 360));
    video.style.setProperty('outline', '1px dashed red', 'important');
    video.style.setProperty('outline-offset', '2px', 'important');
    const originalOutline = video.style.outline;
    const harness = createHarness([video]);
    harness.tunnel.configure(armedSession());
    harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });

    document.dispatchEvent(harness.drop({ text: DROP_TOKEN, trusted: true }));
    await flushMicrotasks();

    expect(video.style.getPropertyPriority('outline')).toBe('important');
    expect(video.style.outline).toContain('3px solid');
    harness.tunnel.destroy();
    expect(video.style.outline).toBe(originalOutline);
    expect(video.style.outlineOffset).toBe('2px');
    expect(video.style.getPropertyPriority('outline')).toBe('important');
    expect(video.style.getPropertyPriority('outline-offset')).toBe('important');
  });

  it('removes target attributes, outlines, prompts, and listeners on destroy', async () => {
    const video = visibleElement('video', rect(40, 50, 640, 360));
    const harness = createHarness([video]);
    harness.tunnel.configure(armedSession());
    harness.tunnel.beginDrag({ sessionId: SESSION_ID, dropToken: DROP_TOKEN });
    document.dispatchEvent(harness.drop({ text: DROP_TOKEN, trusted: true }));
    await flushMicrotasks();
    expect(video.hasAttribute('data-voice-vac-target-id')).toBe(true);

    harness.tunnel.destroy();

    expect(document.querySelector('#vacvox-tunnel-root')).toBeNull();
    expect(video.hasAttribute('data-voice-vac-target-id')).toBe(false);
    expect(video.classList.contains('voice-vac-target-outline')).toBe(false);
    expect(document.querySelector('.voice-vac-play-prompt')).toBeNull();
    const afterDestroy = harness.drop({ text: DROP_TOKEN, trusted: true });
    document.dispatchEvent(afterDestroy);
    expect(afterDestroy.defaultPrevented).toBe(false);
  });

  it('routes runtime arm, drag, cancel, and disconnect only in the top document', () => {
    let listener: ((message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) => void) | undefined;
    const harness = createHarness([]);
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (path: string) => path,
        onMessage: { addListener: vi.fn((value) => { listener = value; }) },
        sendMessage: harness.sendMessage
      }
    });
    registerContentTunnelRuntime({
      document,
      window,
      isTrustedEvent: harness.isTrustedEvent,
      randomUUID: () => TARGET_ID
    });

    const armed = vi.fn();
    listener?.({ type: 'session:armed', session: armedSession() }, {}, armed);
    expect(armed).toHaveBeenCalledWith({ ok: true });
    const host = document.querySelector('#vacvox-tunnel-root');
    expect(host).toBeTruthy();

    const began = vi.fn();
    listener?.({ type: 'drag:begin', sessionId: SESSION_ID, dropToken: DROP_TOKEN }, {}, began);
    expect(began).toHaveBeenCalledWith({ ok: true });
    expect(host?.shadowRoot?.querySelector('.voice-vac-drop-catcher')?.classList.contains('is-active')).toBe(true);

    listener?.({ type: 'drag:cancel', sessionId: SESSION_ID }, {}, vi.fn());
    expect(host?.shadowRoot?.querySelector('.voice-vac-drop-catcher')?.classList.contains('is-active')).toBe(false);

    const disconnected = vi.fn();
    listener?.({ type: 'target-disconnect', sessionId: SESSION_ID }, {}, disconnected);
    expect(disconnected).toHaveBeenCalledWith({ ok: true });
    expect(document.querySelector('#vacvox-tunnel-root')).toBeNull();
  });

  it('plays and pauses only the exact attached HTML media target', async () => {
    const video = visibleElement('video', rect(40, 50, 640, 360));
    const play = vi.spyOn(video, 'play').mockResolvedValue(undefined);
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => undefined);
    const runtime = createRuntimeHarness([video]);
    await runtime.attachTarget();

    await expect(runtime.dispatch({
      target: 'content-tunnel',
      type: 'playback:play',
      sessionId: SESSION_ID,
      targetId: TARGET_ID
    })).resolves.toEqual({ status: 'playing' });
    await expect(runtime.dispatch({
      target: 'content-tunnel',
      type: 'playback:pause',
      sessionId: SESSION_ID,
      targetId: TARGET_ID
    })).resolves.toEqual({ ok: true });

    expect(play).toHaveBeenCalledOnce();
    expect(pause).toHaveBeenCalledOnce();
  });

  it('falls back to one trusted page click without synthesizing a media click', async () => {
    const video = visibleElement('video', rect(40, 50, 640, 360));
    const click = vi.spyOn(video, 'click');
    vi.spyOn(video, 'play').mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    const runtime = createRuntimeHarness([video]);
    await runtime.attachTarget();

    await expect(runtime.dispatch({
      target: 'content-tunnel',
      type: 'playback:play',
      sessionId: SESSION_ID,
      targetId: TARGET_ID
    })).resolves.toEqual({
      status: 'user-play-required',
      code: 'USER_PLAY_REQUIRED'
    });
    expect(runtime.prompt()?.textContent).toBe('Press play once in Chrome.');
    expect(click).not.toHaveBeenCalled();

    document.dispatchEvent(runtime.click({ trusted: false }));
    expect(runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'playback:user-started'
    }));
    document.dispatchEvent(runtime.click({ trusted: true }));
    document.dispatchEvent(runtime.click({ trusted: true }));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage).toHaveBeenLastCalledWith({
      target: 'service-worker',
      type: 'playback:user-started',
      sessionId: SESSION_ID
    });

    await runtime.dispatch({
      target: 'content-tunnel',
      type: 'playback:dispose',
      sessionId: SESSION_ID,
      targetId: TARGET_ID
    });
    expect(runtime.prompt()).toBeNull();
  });

  it('uses an isolated-world global marker that hostile page DOM and string globals cannot spoof', () => {
    document.documentElement.dataset.voiceVacContentTunnelRuntimeV1 = 'true';
    (window as unknown as Record<string, unknown>).voiceVacContentTunnelRuntimeV1 = true;
    const addListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: { addListener },
        sendMessage: vi.fn().mockResolvedValue({ ok: true })
      }
    });

    registerContentTunnelRuntime({ document, window });
    registerContentTunnelRuntime({ document, window });

    expect(addListener).toHaveBeenCalledTimes(1);
    expect(Object.prototype.hasOwnProperty.call(window, RUNTIME_MARKER)).toBe(true);
  });

  it('rejects a stale disconnect without destroying the currently armed session', () => {
    let listener: ((message: Record<string, unknown>, sender: unknown, sendResponse: (response: unknown) => void) => void) | undefined;
    const addListener = vi.fn((value) => { listener = value; });
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: { addListener },
        sendMessage: vi.fn().mockResolvedValue({ ok: true })
      }
    });
    registerContentTunnelRuntime({ document, window, randomUUID: () => TARGET_ID });
    listener?.({ type: 'session:armed', session: armedSession() }, {}, vi.fn());
    listener?.({ type: 'session:armed', session: secondArmedSession() }, {}, vi.fn());

    const stale = vi.fn();
    listener?.({ type: 'target-disconnect', sessionId: SESSION_ID }, {}, stale);
    expect(stale).toHaveBeenCalledWith({ ok: false });
    expect(document.querySelector('#vacvox-tunnel-root')).toBeTruthy();

    const began = vi.fn();
    listener?.({
      type: 'drag:begin',
      sessionId: SECOND_SESSION_ID,
      dropToken: SECOND_DROP_TOKEN
    }, {}, began);
    expect(began).toHaveBeenCalledWith({ ok: true });

    const current = vi.fn();
    listener?.({ type: 'target-disconnect', sessionId: SECOND_SESSION_ID }, {}, current);
    expect(current).toHaveBeenCalledWith({ ok: true });
    expect(document.querySelector('#vacvox-tunnel-root')).toBeNull();
  });

  it('contains no page-local capsule, hose, transcript, copy, or primary-button UI', async () => {
    const harness = createHarness([]);
    expect(harness.tunnel.host.querySelector('[data-role="primary"]')).toBeNull();
    expect(harness.tunnel.host.querySelector('[data-role="copy"]')).toBeNull();
    expect(harness.tunnel.host.querySelector('.vacvox-machine')).toBeNull();
    expect(harness.tunnel.host.textContent).not.toContain('复制全文');

    const css = await readFile(resolve('apps/chrome-extension/public/content-tunnel.css'), 'utf8');
    expect(css).toContain('.voice-vac-drop-catcher');
    expect(css).toContain('.voice-vac-drop-catcher.is-rejected');
    expect(css).toContain('.voice-vac-target-outline');
    expect(css).toContain('.voice-vac-play-prompt');
    expect(css).not.toMatch(/vacvox-machine|vacvox-hose|vacvox-transcript|vacvox-copy|vacvox-primary/u);
  });

  it('keeps the production drop and prompt styles self-contained in the shadow root', () => {
    const harness = createHarness([]);

    expect(harness.tunnel.host.querySelector('link[rel="stylesheet"]')).toBeNull();
    const stylesheet = harness.tunnel.host.querySelector('style')?.textContent ?? '';
    expect(stylesheet).toContain('.voice-vac-drop-catcher');
    expect(stylesheet).toContain('.voice-vac-drop-catcher.is-active');
    expect(stylesheet).toContain('.voice-vac-drop-catcher.is-rejected');
    expect(stylesheet).toContain('.voice-vac-play-prompt');
  });
});

function createHarness(initialElements: Element[]) {
  let elements = initialElements;
  const trusted = new WeakSet<Event>();
  const sendMessage = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => path,
      sendMessage
    },
    storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } }
  });
  const tunnel = mountContentTunnel({
    document,
    window,
    elementsFromPoint: () => elements,
    isTrustedEvent: (event) => event.isTrusted || trusted.has(event),
    randomUUID: () => TARGET_ID,
    sendMessage
  });
  return {
    tunnel,
    sendMessage,
    catcher: () => tunnel.host.querySelector('.voice-vac-drop-catcher'),
    setElements: (next: Element[]) => { elements = next; },
    isTrustedEvent: (event: Event) => event.isTrusted || trusted.has(event),
    drop({ text, trusted: isTrusted }: { text: string; trusted: boolean }) {
      const event = dragEvent('drop', ['text/plain'], text);
      if (isTrusted) trusted.add(event);
      return event;
    },
    dragover(types: string[]) {
      return dragEvent('dragover', types, '');
    },
    click({ trusted: isTrusted }: { trusted: boolean }) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      if (isTrusted) trusted.add(event);
      return event;
    }
  };
}

function createRuntimeHarness(initialElements: Element[]) {
  let listener: RuntimeListener | undefined;
  const trusted = new WeakSet<Event>();
  const sendMessage = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => path,
      onMessage: { addListener: vi.fn((value: RuntimeListener) => { listener = value; }) },
      sendMessage
    }
  });
  registerContentTunnelRuntime({
    document,
    window,
    elementsFromPoint: () => initialElements,
    isTrustedEvent: (event) => event.isTrusted || trusted.has(event),
    randomUUID: () => TARGET_ID,
    sendMessage
  });
  const dispatch = (message: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('content response timeout')), 500);
    const sendResponse = (response: unknown) => {
      clearTimeout(timeout);
      resolve(response);
    };
    const keepAlive = listener?.(message, {}, sendResponse);
    if (keepAlive !== true && message.type?.toString().startsWith('playback:')) {
      queueMicrotask(() => {
        if (keepAlive === undefined) {
          clearTimeout(timeout);
          reject(new Error('playback message was not handled'));
        }
      });
    }
  });
  return {
    dispatch,
    sendMessage,
    prompt: () => document.querySelector('#vacvox-tunnel-root')?.shadowRoot
      ?.querySelector<HTMLButtonElement>('.voice-vac-play-prompt') ?? null,
    click({ trusted: isTrusted }: { trusted: boolean }) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      if (isTrusted) trusted.add(event);
      return event;
    },
    async attachTarget() {
      await dispatch({ type: 'session:armed', session: armedSession() });
      await dispatch({ type: 'drag:begin', sessionId: SESSION_ID, dropToken: DROP_TOKEN });
      const dropped = dragEvent('drop', ['text/plain'], DROP_TOKEN);
      trusted.add(dropped);
      document.dispatchEvent(dropped);
      await flushMicrotasks();
    }
  };
}

type RuntimeListener = (
  message: Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => boolean | void;

function dragEvent(type: 'dragover' | 'drop', types: string[], text: string): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperties(event, {
    clientX: { value: 240 },
    clientY: { value: 180 },
    screenX: { value: 1240 },
    screenY: { value: 680 },
    dataTransfer: {
      value: {
        types,
        getData: (format: string) => format === 'text/plain' ? text : ''
      }
    }
  });
  return event;
}

function armedSession(): TargetSession {
  return {
    schemaVersion: 1,
    id: SESSION_ID,
    tabId: 17,
    windowId: 1,
    frameId: 0,
    documentId: 'doc-main',
    pageOrigin: 'https://video.example',
    url: 'https://video.example/watch',
    title: 'Target video',
    dropNonce: NONCE,
    dropToken: DROP_TOKEN,
    status: 'armed',
    armedAt: 1,
    updatedAt: 1
  };
}

function secondArmedSession(): TargetSession {
  return {
    ...armedSession(),
    id: SECOND_SESSION_ID,
    dropNonce: SECOND_NONCE,
    dropToken: SECOND_DROP_TOKEN,
    documentId: 'doc-second',
    url: 'https://video.example/second'
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function messageType(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'type' in value
    ? String((value as { type?: unknown }).type)
    : undefined;
}

function sentMessageTypes(sendMessage: ReturnType<typeof vi.fn>): string[] {
  return sendMessage.mock.calls.map((call) => messageType(call[0]) ?? 'unknown');
}

function visibleElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  bounds: { x: number; y: number; width: number; height: number }
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({
      ...bounds,
      top: bounds.y,
      left: bounds.x,
      right: bounds.x + bounds.width,
      bottom: bounds.y + bounds.height,
      toJSON: () => bounds
    })
  });
  document.body.append(element);
  return element;
}

function rect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height };
}
