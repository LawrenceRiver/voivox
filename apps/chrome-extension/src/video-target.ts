import type { TargetRect, VideoTarget } from './target-session.js';

const DIRECT_TARGET_ATTRIBUTE = 'data-voice-vac-target-id';
const MEDIA_SEMANTICS = /(?:^|[\s_-])(audio|media|player|video)(?:$|[\s_-])/u;
const VOICE_VAC_OVERLAY = [
  '#vacvox-tunnel-root',
  '.voice-vac-drop-catcher',
  '[data-voice-vac-overlay]'
].join(',');

export type DropCoordinates = Readonly<{
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}>;

export type ResolveVideoTargetInput = DropCoordinates & Readonly<{
  documentId: string;
  frameId: number;
  elements: readonly Element[];
  randomUUID?: () => string;
}>;

export function screenRectFromDrop(event: DropCoordinates, rect: TargetRect): TargetRect {
  return {
    x: event.screenX - event.clientX + rect.x,
    y: event.screenY - event.clientY + rect.y,
    width: rect.width,
    height: rect.height
  };
}

export function resolveVideoTarget(input: ResolveVideoTargetInput): VideoTarget | undefined {
  const candidates = uniqueElements(input.elements).filter((element) => (
    !isVoiceVacOverlay(element) && isVisible(element)
  ));
  const direct = candidates.find(isHtmlMedia);
  if (direct) return createTarget(input, direct, 'html-media');
  const embedded = candidates.find(isEmbeddedPlayer);
  if (embedded) return createTarget(input, embedded, 'embedded-player');
  const custom = candidates.find(hasCustomMediaSemantics);
  return custom ? createTarget(input, custom, 'tab-audio') : undefined;
}

function createTarget(
  input: ResolveVideoTargetInput,
  element: Element,
  kind: VideoTarget['kind']
): VideoTarget {
  const viewportRect = elementRect(element);
  const id = (input.randomUUID ?? (() => crypto.randomUUID()))();
  const direct = kind === 'html-media';
  if (direct) element.setAttribute(DIRECT_TARGET_ATTRIBUTE, id);
  return {
    id,
    kind,
    ...(direct ? { tag: tagName(element) as 'video' | 'audio' } : {}),
    frameId: input.frameId,
    documentId: input.documentId,
    viewportRect,
    screenRect: screenRectFromDrop(input, viewportRect),
    activationPoint: {
      x: viewportRect.x + viewportRect.width / 2,
      y: viewportRect.y + viewportRect.height / 2
    },
    canDirectPlay: direct
  };
}

function uniqueElements(elements: readonly Element[]): Element[] {
  return [...new Set(elements)];
}

function isVoiceVacOverlay(element: Element): boolean {
  return element.matches(VOICE_VAC_OVERLAY) || element.closest(VOICE_VAC_OVERLAY) !== null;
}

function isVisible(element: Element): boolean {
  const rect = elementRect(element);
  if (rect.width <= 0 || rect.height <= 0) return false;

  const checkVisibility = (element as Element & {
    checkVisibility?: (options?: {
      checkOpacity?: boolean;
      checkVisibilityCSS?: boolean;
    }) => boolean;
  }).checkVisibility;
  if (typeof checkVisibility === 'function') {
    try {
      if (!checkVisibility.call(element, {
        checkOpacity: true,
        checkVisibilityCSS: true
      })) return false;
    } catch {
      // Older DOM shims may expose an incompatible implementation. The
      // ancestor walk below is the compatibility fallback.
    }
  }

  // Unlike display and opacity, visibility is inherited but a descendant can
  // explicitly restore `visible`. Its computed value therefore represents the
  // effective visibility without treating every hidden ancestor as absolute.
  const candidateStyle = getComputedStyle(element);
  if (candidateStyle.visibility === 'hidden'
    || candidateStyle.visibility === 'collapse') {
    return false;
  }

  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.getAttribute('aria-hidden') === 'true') return false;
    if (current instanceof HTMLElement && current.hidden) return false;

    const style = getComputedStyle(current);
    if (style.display === 'none') return false;

    const opacity = Number.parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity <= 0) return false;
  }

  return true;
}

function isHtmlMedia(element: Element): boolean {
  const tag = tagName(element);
  return tag === 'video' || tag === 'audio';
}

function isEmbeddedPlayer(element: Element): boolean {
  const tag = tagName(element);
  return tag === 'iframe' || tag === 'embed' || tag === 'object';
}

function hasCustomMediaSemantics(element: Element): boolean {
  if (element.hasAttribute('data-player')
    || element.hasAttribute('data-video-player')
    || element.hasAttribute('data-media-player')) {
    return true;
  }
  const semantics = [
    element.id,
    element.className,
    element.getAttribute('role'),
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('data-testid')
  ].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
  return MEDIA_SEMANTICS.test(semantics);
}

function elementRect(element: Element): TargetRect {
  const bounds = element.getBoundingClientRect();
  return {
    x: Number.isFinite(bounds.x) ? bounds.x : bounds.left,
    y: Number.isFinite(bounds.y) ? bounds.y : bounds.top,
    width: bounds.width,
    height: bounds.height
  };
}

function tagName(element: Element): string {
  return element.tagName.toLowerCase();
}
