// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveVideoTarget,
  screenRectFromDrop
} from '../src/video-target.js';

const DOCUMENT_ID = 'doc-main-frame';
const TARGET_ID = '0f9277ea-8f9a-4e4e-8cf1-af1afcde2e07';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('screenRectFromDrop', () => {
  it('derives screen coordinates from the trusted drop event', () => {
    expect(screenRectFromDrop(
      { clientX: 300, clientY: 200, screenX: 1300, screenY: 700 },
      { x: 40, y: 20, width: 640, height: 360 }
    )).toEqual({ x: 1040, y: 520, width: 640, height: 360 });
  });
});

describe('resolveVideoTarget', () => {
  it('prefers visible HTML media regardless of lower-priority hit-test order', () => {
    const custom = visibleElement('div', rect(20, 20, 800, 450));
    custom.className = 'custom-video-player';
    const embedded = visibleElement('iframe', rect(30, 30, 700, 400));
    const video = visibleElement('video', rect(40, 50, 640, 360));

    const target = resolveVideoTarget(input([custom, embedded, video]));

    expect(target).toEqual({
      id: TARGET_ID,
      kind: 'html-media',
      tag: 'video',
      frameId: 0,
      documentId: DOCUMENT_ID,
      viewportRect: rect(40, 50, 640, 360),
      screenRect: rect(1040, 550, 640, 360),
      activationPoint: { x: 360, y: 230 },
      canDirectPlay: true
    });
    expect(video.getAttribute('data-voice-vac-target-id')).toBe(TARGET_ID);
  });

  it('uses the first visible audio or video element and rejects hidden or zero-area media', () => {
    const hiddenVideo = visibleElement('video', rect(10, 10, 400, 225));
    hiddenVideo.style.display = 'none';
    const zeroAreaAudio = visibleElement('audio', rect(10, 10, 0, 30));
    const audio = visibleElement('audio', rect(60, 80, 300, 40));
    const laterVideo = visibleElement('video', rect(90, 100, 320, 180));

    const target = resolveVideoTarget(input([hiddenVideo, zeroAreaAudio, audio, laterVideo]));

    expect(target).toMatchObject({
      kind: 'html-media',
      tag: 'audio',
      viewportRect: rect(60, 80, 300, 40)
    });
    expect(hiddenVideo.getAttribute('data-voice-vac-target-id')).toBeNull();
    expect(zeroAreaAudio.getAttribute('data-voice-vac-target-id')).toBeNull();
  });

  it('does not let media under a zero-opacity ancestor outrank a visible target', () => {
    const transparentAncestor = document.createElement('div');
    transparentAncestor.style.opacity = '0.0';
    const obscured = visibleElement('video', rect(10, 10, 900, 506));
    transparentAncestor.append(obscured);
    document.body.prepend(transparentAncestor);
    const visible = visibleElement('video', rect(100, 120, 640, 360));

    const target = resolveVideoTarget(input([obscured, visible]));

    expect(target?.viewportRect).toEqual(rect(100, 120, 640, 360));
    expect(obscured.getAttribute('data-voice-vac-target-id')).toBeNull();
  });

  it.each([
    ['display none', (ancestor: HTMLElement) => { ancestor.style.display = 'none'; }],
    ['hidden attribute', (ancestor: HTMLElement) => { ancestor.hidden = true; }],
    ['aria hidden', (ancestor: HTMLElement) => { ancestor.setAttribute('aria-hidden', 'true'); }]
  ] as const)('rejects media beneath an ancestor with %s', (_label, hide) => {
    const ancestor = document.createElement('div');
    hide(ancestor);
    const obscured = visibleElement('video', rect(10, 10, 900, 506));
    ancestor.append(obscured);
    document.body.prepend(ancestor);

    expect(resolveVideoTarget(input([obscured]))).toBeUndefined();
    expect(obscured.getAttribute('data-voice-vac-target-id')).toBeNull();
  });

  it('rejects inherited visibility hidden when the media does not override it', () => {
    const hiddenAncestor = document.createElement('div');
    hiddenAncestor.style.visibility = 'hidden';
    const obscured = visibleElement('video', rect(10, 10, 900, 506));
    hiddenAncestor.append(obscured);
    document.body.prepend(hiddenAncestor);

    expect(resolveVideoTarget(input([obscured]))).toBeUndefined();
    expect(obscured.getAttribute('data-voice-vac-target-id')).toBeNull();
  });

  it('accepts media that explicitly restores visibility beneath a hidden ancestor', () => {
    const hiddenAncestor = document.createElement('div');
    hiddenAncestor.style.visibility = 'hidden';
    const visible = visibleElement('video', rect(100, 120, 640, 360));
    visible.style.visibility = 'visible';
    const checkVisibility = vi.fn(() => true);
    Object.defineProperty(visible, 'checkVisibility', { value: checkVisibility });
    hiddenAncestor.append(visible);
    document.body.prepend(hiddenAncestor);

    expect(resolveVideoTarget(input([visible]))).toMatchObject({
      kind: 'html-media',
      viewportRect: rect(100, 120, 640, 360)
    });
    expect(checkVisibility).toHaveBeenCalledWith({
      checkOpacity: true,
      checkVisibilityCSS: true
    });
  });

  it('prefers the native effective-visibility check with opacity and CSS visibility enabled', () => {
    const nativeHidden = visibleElement('video', rect(10, 10, 900, 506));
    const checkVisibility = vi.fn(() => false);
    Object.defineProperty(nativeHidden, 'checkVisibility', { value: checkVisibility });
    const visible = visibleElement('video', rect(100, 120, 640, 360));

    const target = resolveVideoTarget(input([nativeHidden, visible]));

    expect(checkVisibility).toHaveBeenCalledWith({
      checkOpacity: true,
      checkVisibilityCSS: true
    });
    expect(target?.viewportRect).toEqual(rect(100, 120, 640, 360));
  });

  it('falls back to ancestor checks when the native visibility check throws', () => {
    const transparentAncestor = document.createElement('div');
    transparentAncestor.style.opacity = '0';
    const obscured = visibleElement('video', rect(10, 10, 900, 506));
    const checkVisibility = vi.fn(() => { throw new TypeError('unsupported options'); });
    Object.defineProperty(obscured, 'checkVisibility', { value: checkVisibility });
    transparentAncestor.append(obscured);
    document.body.prepend(transparentAncestor);

    expect(resolveVideoTarget(input([obscured]))).toBeUndefined();
    expect(checkVisibility).toHaveBeenCalledOnce();
    expect(obscured.getAttribute('data-voice-vac-target-id')).toBeNull();
  });

  it.each(['iframe', 'embed', 'object'] as const)(
    'classifies a visible %s as an embedded player with the main-frame identity',
    (tag) => {
      const embedded = visibleElement(tag, rect(100, 120, 500, 280));

      expect(resolveVideoTarget(input([embedded]))).toMatchObject({
        id: TARGET_ID,
        kind: 'embedded-player',
        frameId: 0,
        documentId: DOCUMENT_ID,
        viewportRect: rect(100, 120, 500, 280),
        canDirectPlay: false
      });
    }
  );

  it('classifies a visible custom player with explicit media semantics as tab audio', () => {
    const custom = visibleElement('section', rect(15, 25, 900, 506));
    custom.setAttribute('role', 'application');
    custom.setAttribute('aria-label', 'Concert video player');

    expect(resolveVideoTarget(input([custom]))).toMatchObject({
      id: TARGET_ID,
      kind: 'tab-audio',
      frameId: 0,
      documentId: DOCUMENT_ID,
      viewportRect: rect(15, 25, 900, 506),
      canDirectPlay: false
    });
  });

  it('skips Voice VAC overlay descendants before selecting a page target', () => {
    const overlay = document.createElement('div');
    overlay.className = 'voice-vac-drop-catcher';
    const overlayVideo = visibleElement('video', rect(0, 0, 1200, 800));
    overlay.append(overlayVideo);
    document.body.append(overlay);
    const pageVideo = visibleElement('video', rect(200, 150, 640, 360));

    const target = resolveVideoTarget(input([overlayVideo, overlay, pageVideo]));

    expect(target?.viewportRect).toEqual(rect(200, 150, 640, 360));
    expect(overlayVideo.getAttribute('data-voice-vac-target-id')).toBeNull();
  });

  it('returns undefined for an ordinary visible element without media semantics', () => {
    const article = visibleElement('article', rect(10, 20, 600, 400));
    article.textContent = 'A normal article';

    expect(resolveVideoTarget(input([article]))).toBeUndefined();
    expect(resolveVideoTarget(input([]))).toBeUndefined();
  });
});

function input(elements: Element[]) {
  return {
    clientX: 300,
    clientY: 200,
    screenX: 1300,
    screenY: 700,
    documentId: DOCUMENT_ID,
    frameId: 0,
    elements,
    randomUUID: () => TARGET_ID
  };
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
