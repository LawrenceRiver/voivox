import { matchesDropToken } from './drop-protocol.js';
import {
  isTargetSession,
  type TargetRect,
  type TargetSession,
  type VideoTarget
} from './target-session.js';
import { resolveVideoTarget } from './video-target.js';

const ROOT_ID = 'vacvox-tunnel-root';
const RUNTIME_MARKER = Symbol.for('com.voice-vac.content-tunnel-runtime.v1');
const TARGET_ATTRIBUTE = 'data-voice-vac-target-id';
const TARGET_OUTLINE_CLASS = 'voice-vac-target-outline';
const MEDIA_TARGET_SEMANTICS = /(?:^|[\s_-])(audio|media|player|video)(?:$|[\s_-])/u;
const SHADOW_STYLES = `
.voice-vac-drop-catcher {
  background: transparent;
  cursor: default;
  inset: 0;
  pointer-events: none;
  position: fixed;
  z-index: 2147483647;
}
.voice-vac-drop-catcher.is-active {
  cursor: copy;
  pointer-events: auto;
}
.voice-vac-drop-catcher.is-rejected {
  box-shadow: inset 0 0 0 2px rgb(209 153 59 / 72%);
}
.voice-vac-drop-catcher.is-rejected::after {
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  backdrop-filter: blur(18px) saturate(150%);
  background: rgb(255 249 236 / 94%);
  border: 1px solid rgb(209 153 59 / 42%);
  border-radius: 999px;
  box-shadow: 0 8px 24px rgb(88 61 18 / 16%);
  color: #6f501d;
  content: "No playable video found";
  font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  left: 50%;
  padding: 10px 15px;
  position: fixed;
  top: 24px;
  transform: translateX(-50%);
}
.voice-vac-play-prompt {
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  backdrop-filter: blur(18px) saturate(150%);
  background: rgb(246 250 252 / 88%);
  border: 1px solid rgb(255 255 255 / 94%);
  border-radius: 999px;
  box-shadow: 0 8px 24px rgb(28 52 67 / 20%), inset 0 1px 0 rgb(255 255 255 / 98%);
  color: #334a57;
  cursor: pointer;
  font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
  padding: 10px 15px;
  pointer-events: auto;
  white-space: nowrap;
  z-index: 2147483647;
}`;

type DragIdentity = Readonly<{
  sessionId: string;
  dropToken: string;
}>;

type ContentTunnelDependencies = Readonly<{
  document?: Document;
  window?: Window;
  sendMessage?: (message: unknown) => Promise<unknown>;
  elementsFromPoint?: (clientX: number, clientY: number) => readonly Element[];
  isTrustedEvent?: (event: Event) => boolean;
  randomUUID?: () => string;
}>;

type ResolvedElementTarget = Readonly<{
  element: Element;
  target: VideoTarget;
}>;

type OriginalOutline = Readonly<{
  outline: string;
  outlineOffset: string;
  outlinePriority: string;
  outlineOffsetPriority: string;
}>;

type PublicationContext = Readonly<{
  generation: number;
  sessionId: string;
}>;

type QueuedPreview = PublicationContext & Readonly<{
  message: Record<string, unknown>;
}>;

type TunnelState = 'armed' | 'connecting' | 'detecting' | 'dragging' | 'ready' | 'rejected';

export type MountedContentTunnel = {
  host: HTMLElement;
  configure: (session: TargetSession) => void;
  beginDrag: (identity: DragIdentity) => boolean;
  cancelDrag: (sessionId?: string) => boolean;
  play: (sessionId: string, targetId: string) => Promise<ContentPlaybackResult>;
  pause: (sessionId: string, targetId: string) => boolean;
  promptForPlayback: (sessionId: string, targetId: string) => boolean;
  disposePlayback: (sessionId: string, targetId: string) => boolean;
  destroy: () => void;
};

type ContentPlaybackResult =
  | { status: 'playing' }
  | { status: 'user-play-required'; code: 'USER_PLAY_REQUIRED' }
  | { status: 'failed'; code: 'NO_PLAYABLE_MEDIA' | 'TARGET_NAVIGATED' };

const mountedByDocument = new WeakMap<Document, MountedContentTunnel>();

export function mountContentTunnel(
  dependencies: ContentTunnelDependencies = {}
): MountedContentTunnel {
  const doc = dependencies.document ?? document;
  const win = dependencies.window ?? window;
  const previous = mountedByDocument.get(doc);
  previous?.destroy();
  doc.getElementById(ROOT_ID)?.remove();

  const sendMessage = dependencies.sendMessage ?? ((message: unknown) => (
    chrome.runtime.sendMessage(message)
  ));
  const elementsFromPoint = dependencies.elementsFromPoint ?? ((clientX, clientY) => (
    typeof doc.elementsFromPoint === 'function'
      ? doc.elementsFromPoint(clientX, clientY)
      : []
  ));
  const isTrustedEvent = dependencies.isTrustedEvent ?? ((event: Event) => event.isTrusted);
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());

  const root = doc.createElement('div');
  root.id = ROOT_ID;
  root.dataset.voiceVacOverlay = 'true';
  const shadow = root.attachShadow?.({ mode: 'open' }) ?? root;
  const host = doc.createElement('div');
  host.dataset.voiceVacOverlay = 'true';
  const stylesheet = doc.createElement('style');
  stylesheet.textContent = SHADOW_STYLES;
  const catcher = doc.createElement('div');
  catcher.className = 'voice-vac-drop-catcher';
  catcher.dataset.voiceVacOverlay = 'true';
  catcher.setAttribute('aria-hidden', 'true');
  Object.assign(catcher.style, {
    background: 'transparent',
    inset: '0',
    pointerEvents: 'none',
    position: 'fixed',
    zIndex: '2147483647'
  });
  host.append(stylesheet, catcher);
  shadow.append(host);
  doc.documentElement.append(root);

  let session: TargetSession | undefined;
  let dragSession: TargetSession | undefined;
  let candidate: ResolvedElementTarget | undefined;
  let attached: ResolvedElementTarget | undefined;
  let prompt: HTMLButtonElement | undefined;
  let attachedEndedListener: (() => void) | undefined;
  let trustedPlaybackListener: ((event: Event) => void) | undefined;
  let destroyed = false;
  let generation = 0;
  let dropPending = false;
  let pendingPreview: QueuedPreview | undefined;
  let previewDrain: Promise<void> | undefined;
  let publicationTail: Promise<void> = Promise.resolve();
  const originalOutlines = new WeakMap<Element, OriginalOutline>();

  const publishBestEffort = (message: unknown): void => {
    void Promise.resolve(sendMessage(message)).catch(() => undefined);
  };

  const setTunnelState = (state: TunnelState): void => {
    host.dataset.tunnelState = state;
    const rejected = state === 'rejected';
    catcher.classList.toggle('is-rejected', rejected);
    if (rejected) {
      catcher.setAttribute('aria-label', 'No playable video found');
    } else {
      catcher.removeAttribute('aria-label');
    }
  };

  const isCurrentPublication = (context: PublicationContext): boolean => (
    !destroyed
    && context.generation === generation
    && session?.id === context.sessionId
    && dragSession?.id === context.sessionId
  );

  const sendAcknowledged = async (message: Record<string, unknown>): Promise<boolean> => {
    try {
      const response = await sendMessage(message);
      return isRecord(response) && response.ok === true;
    } catch {
      return false;
    }
  };

  const enqueuePublication = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = publicationTail.then(operation, operation);
    publicationTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const publishRejection = async (
    context: PublicationContext,
    code: string
  ): Promise<void> => {
    if (!isCurrentPublication(context)) return;
    try {
      await sendMessage({
        target: 'service-worker',
        type: 'target:rejected',
        sessionId: context.sessionId,
        error: { code, retryable: true }
      });
    } catch {
      // The catcher already exposes a stable local rejection state.
    }
  };

  const startPreviewDrain = (): void => {
    if (previewDrain) return;
    const drain = enqueuePublication(async () => {
      while (pendingPreview) {
        const next = pendingPreview;
        pendingPreview = undefined;
        if (!isCurrentPublication(next)) continue;
        const acknowledged = await sendAcknowledged(next.message);
        if (!acknowledged && isCurrentPublication(next) && !dropPending) {
          setTunnelState('rejected');
        }
      }
    });
    previewDrain = drain.finally(() => {
      previewDrain = undefined;
      if (pendingPreview) startPreviewDrain();
    });
  };

  const schedulePreview = (preview: QueuedPreview): void => {
    pendingPreview = preview;
    startPreviewDrain();
  };

  const setCatcherActive = (active: boolean): void => {
    catcher.classList.toggle('is-active', active);
    catcher.setAttribute('aria-hidden', String(!active));
    catcher.style.pointerEvents = active ? 'auto' : 'none';
  };

  const decorate = (resolved: ResolvedElementTarget): void => {
    const { element, target } = resolved;
    if (target.kind === 'html-media') element.setAttribute(TARGET_ATTRIBUTE, target.id);
    if (element instanceof HTMLElement && !originalOutlines.has(element)) {
      originalOutlines.set(element, {
        outline: element.style.outline,
        outlineOffset: element.style.outlineOffset,
        outlinePriority: element.style.getPropertyPriority('outline'),
        outlineOffsetPriority: element.style.getPropertyPriority('outline-offset')
      });
      element.style.setProperty('outline', '3px solid rgba(91, 155, 213, 0.9)', 'important');
      element.style.setProperty('outline-offset', '4px', 'important');
    }
    element.classList.add(TARGET_OUTLINE_CLASS);
  };

  const undecorate = (resolved: ResolvedElementTarget | undefined): void => {
    if (!resolved) return;
    const { element, target } = resolved;
    element.classList.remove(TARGET_OUTLINE_CLASS);
    if (element instanceof HTMLElement) {
      const original = originalOutlines.get(element);
      if (original) {
        element.style.setProperty('outline', original.outline, original.outlinePriority);
        element.style.setProperty(
          'outline-offset',
          original.outlineOffset,
          original.outlineOffsetPriority
        );
        originalOutlines.delete(element);
      }
    }
    if (target.kind === 'html-media'
      && element.getAttribute(TARGET_ATTRIBUTE) === target.id) {
      element.removeAttribute(TARGET_ATTRIBUTE);
    }
  };

  const clearCandidate = (): void => {
    if (candidate?.element !== attached?.element) undecorate(candidate);
    candidate = undefined;
  };

  const removePrompt = (): void => {
    prompt?.remove();
    prompt = undefined;
    if (trustedPlaybackListener) {
      doc.removeEventListener('click', trustedPlaybackListener, true);
      trustedPlaybackListener = undefined;
    }
  };

  const clearAttached = (): void => {
    removePrompt();
    if (attached?.element instanceof HTMLMediaElement && attachedEndedListener) {
      attached.element.removeEventListener('ended', attachedEndedListener);
    }
    attachedEndedListener = undefined;
    undecorate(attached);
    attached = undefined;
  };

  const resolveAt = (event: DragEvent): ResolvedElementTarget | undefined => {
    const elements = [...elementsFromPoint(event.clientX, event.clientY)];
    const target = resolveVideoTarget({
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      documentId: dragSession?.documentId ?? session?.documentId ?? 'unknown-document',
      frameId: dragSession?.frameId ?? session?.frameId ?? 0,
      elements,
      randomUUID
    });
    if (!target) return undefined;
    const element = findResolvedElement(elements, target);
    if (target.kind === 'html-media'
      && element?.getAttribute(TARGET_ATTRIBUTE) === target.id) {
      element.removeAttribute(TARGET_ATTRIBUTE);
    }
    return element ? { element, target } : undefined;
  };

  const compatibilityFields = (target: VideoTarget): Record<string, unknown> => ({
    targetRect: target.screenRect,
    pageEndpoint: {
      screenX: target.screenRect.x + target.screenRect.width / 2,
      screenY: target.screenRect.y + target.screenRect.height * 0.12
    },
    tabTitle: doc.title || session?.title || 'Current video',
    url: win.location.href
  });

  const showPlayPrompt = (target: VideoTarget, awaitTrustedClick = false): void => {
    removePrompt();
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'voice-vac-play-prompt';
    button.dataset.voiceVacOverlay = 'true';
    button.tabIndex = -1;
    button.textContent = 'Press play once in Chrome.';
    Object.assign(button.style, promptPosition(target.viewportRect), {
      pointerEvents: 'none',
      position: 'fixed',
      zIndex: '2147483647'
    });
    if (awaitTrustedClick) {
      trustedPlaybackListener = (event: Event) => {
        if (!isTrustedEvent(event) || !session || attached?.target.id !== target.id) return;
        const activeSessionId = session.id;
        removePrompt();
        publishBestEffort({
          target: 'service-worker',
          type: 'playback:user-started',
          sessionId: activeSessionId
        });
      };
      doc.addEventListener('click', trustedPlaybackListener, true);
    }
    host.append(button);
    prompt = button;
  };

  const isExactAttachedTarget = (sessionId: string, targetId: string): boolean => (
    !destroyed
    && session?.id === sessionId
    && attached?.target.id === targetId
    && attached.target.documentId === session.documentId
    && attached.target.frameId === session.frameId
  );

  const playAttached = async (
    sessionId: string,
    targetId: string
  ): Promise<ContentPlaybackResult> => {
    if (!isExactAttachedTarget(sessionId, targetId)) {
      return { status: 'failed', code: 'TARGET_NAVIGATED' };
    }
    const media = attached?.element;
    if (!(media instanceof HTMLMediaElement)) {
      showPlayPrompt(attached!.target, true);
      return { status: 'user-play-required', code: 'USER_PLAY_REQUIRED' };
    }
    try {
      await media.play();
      removePrompt();
      return { status: 'playing' };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        showPlayPrompt(attached!.target, true);
        return { status: 'user-play-required', code: 'USER_PLAY_REQUIRED' };
      }
      return { status: 'failed', code: 'NO_PLAYABLE_MEDIA' };
    }
  };

  const pauseAttached = (sessionId: string, targetId: string): boolean => {
    if (!isExactAttachedTarget(sessionId, targetId)) return false;
    const media = attached?.element;
    if (media instanceof HTMLMediaElement) media.pause();
    return true;
  };

  const promptForPlayback = (sessionId: string, targetId: string): boolean => {
    if (!isExactAttachedTarget(sessionId, targetId)) return false;
    showPlayPrompt(attached!.target, true);
    return true;
  };

  const disposePlayback = (sessionId: string, targetId: string): boolean => {
    if (!isExactAttachedTarget(sessionId, targetId)) return false;
    removePrompt();
    return true;
  };

  const onDragOver = (event: DragEvent): void => {
    if (!dragSession || !hasPlainText(event.dataTransfer?.types)) return;
    event.preventDefault();
    if (dropPending) return;
    clearCandidate();
    const resolved = resolveAt(event);
    if (!resolved) return;
    candidate = resolved;
    decorate(resolved);
    setTunnelState('detecting');
    schedulePreview({
      generation,
      sessionId: dragSession.id,
      message: {
        target: 'service-worker',
        type: 'target:preview',
        sessionId: dragSession.id,
        videoTarget: resolved.target,
        ...compatibilityFields(resolved.target)
      }
    });
  };

  const onDrop = (event: DragEvent): void => {
    const active = dragSession;
    if (!active || !isTrustedEvent(event)) return;
    const supplied = event.dataTransfer?.getData('text/plain') ?? '';
    if (!matchesDropToken(active, supplied)) return;
    event.preventDefault();
    if (dropPending) return;
    clearCandidate();
    const resolved = resolveAt(event);
    if (!resolved) {
      const context = { generation, sessionId: active.id };
      pendingPreview = undefined;
      setTunnelState('rejected');
      void enqueuePublication(() => publishRejection(context, 'NO_PLAYABLE_MEDIA'));
      return;
    }

    const context = { generation, sessionId: active.id };
    const readyMessage = {
      target: 'service-worker',
      type: 'target:ready',
      sessionId: active.id,
      videoTarget: resolved.target,
      ...compatibilityFields(resolved.target)
    };
    dropPending = true;
    pendingPreview = undefined;
    setTunnelState('connecting');
    void enqueuePublication(async () => {
      if (!isCurrentPublication(context)) return;
      const acknowledged = await sendAcknowledged(readyMessage);
      if (!isCurrentPublication(context)) return;
      dropPending = false;
      if (!acknowledged) {
        setTunnelState('rejected');
        await publishRejection(context, 'TARGET_READY_NOT_ACKNOWLEDGED');
        return;
      }

      clearAttached();
      attached = resolved;
      decorate(resolved);
      if (resolved.element instanceof HTMLMediaElement) {
        const attachedSessionId = active.id;
        const attachedTargetId = resolved.target.id;
        attachedEndedListener = () => {
          publishBestEffort({
            target: 'service-worker',
            type: 'playback:ended',
            sessionId: attachedSessionId,
            targetId: attachedTargetId
          });
        };
        resolved.element.addEventListener('ended', attachedEndedListener, { once: true });
      }
      dragSession = undefined;
      setCatcherActive(false);
      setTunnelState('ready');
      if (!resolved.target.canDirectPlay) showPlayPrompt(resolved.target);
    });
  };

  const onPageHide = (): void => mounted.destroy();
  doc.addEventListener('dragover', onDragOver);
  doc.addEventListener('drop', onDrop);
  win.addEventListener('pagehide', onPageHide, { once: true });

  const mounted: MountedContentTunnel = {
    host,
    configure: (nextSession) => {
      if (destroyed) return;
      clearCandidate();
      clearAttached();
      generation += 1;
      dropPending = false;
      pendingPreview = undefined;
      dragSession = undefined;
      session = nextSession;
      setCatcherActive(false);
      setTunnelState('armed');
    },
    beginDrag: (identity) => {
      if (destroyed
        || !session
        || identity.sessionId !== session.id
        || !matchesDropToken(session, identity.dropToken)) {
        return false;
      }
      clearCandidate();
      clearAttached();
      generation += 1;
      dropPending = false;
      pendingPreview = undefined;
      dragSession = session;
      setCatcherActive(true);
      setTunnelState('dragging');
      return true;
    },
    cancelDrag: (sessionId) => {
      if (destroyed
        || !dragSession
        || (sessionId !== undefined && dragSession.id !== sessionId)) {
        return false;
      }
      clearCandidate();
      generation += 1;
      dropPending = false;
      pendingPreview = undefined;
      dragSession = undefined;
      setCatcherActive(false);
      setTunnelState('armed');
      return true;
    },
    play: playAttached,
    pause: pauseAttached,
    promptForPlayback,
    disposePlayback,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      dropPending = false;
      pendingPreview = undefined;
      doc.removeEventListener('dragover', onDragOver);
      doc.removeEventListener('drop', onDrop);
      win.removeEventListener('pagehide', onPageHide);
      clearCandidate();
      clearAttached();
      dragSession = undefined;
      session = undefined;
      setCatcherActive(false);
      root.remove();
      if (mountedByDocument.get(doc) === mounted) mountedByDocument.delete(doc);
    }
  };
  mountedByDocument.set(doc, mounted);
  return mounted;
}

export function registerContentTunnelRuntime(
  dependencies: ContentTunnelDependencies = {}
): void {
  const doc = dependencies.document ?? document;
  const win = dependencies.window ?? window;
  if (win.top !== win) return;
  const runtimeGlobal = win as unknown as Record<PropertyKey, unknown>;
  if (Object.prototype.hasOwnProperty.call(runtimeGlobal, RUNTIME_MARKER)) return;
  Object.defineProperty(runtimeGlobal, RUNTIME_MARKER, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({ owner: 'voice-vac', version: 1 }),
    writable: false
  });
  let mounted: MountedContentTunnel | undefined;
  let activeSessionId: string | undefined;

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isRecord(message)) return;
    if (message.type === 'session:armed') {
      if (!isTargetSession(message.session)) {
        sendResponse({ ok: false });
        return;
      }
      mounted ??= mountContentTunnel(dependencies);
      mounted.configure(message.session);
      activeSessionId = message.session.id;
      sendResponse({ ok: true });
      return;
    }
    if (message.type === 'drag:begin') {
      const ok = typeof message.sessionId === 'string'
        && typeof message.dropToken === 'string'
        && (mounted?.beginDrag({
          sessionId: message.sessionId,
          dropToken: message.dropToken
        }) ?? false);
      sendResponse({ ok });
      return;
    }
    if (message.type === 'drag:cancel') {
      const ok = typeof message.sessionId === 'string'
        && (mounted?.cancelDrag(message.sessionId) ?? false);
      sendResponse({ ok });
      return;
    }
    if (message.type === 'target-disconnect') {
      const ok = typeof message.sessionId === 'string'
        && message.sessionId === activeSessionId
        && mounted !== undefined;
      if (ok) {
        mounted?.destroy();
        mounted = undefined;
        activeSessionId = undefined;
      }
      sendResponse({ ok });
      return;
    }
    if (message.target !== 'content-tunnel'
      || typeof message.sessionId !== 'string'
      || typeof message.targetId !== 'string') {
      return;
    }
    if (message.type === 'playback:play') {
      if (!mounted) {
        sendResponse({ status: 'failed', code: 'TARGET_NAVIGATED' });
        return;
      }
      void mounted.play(message.sessionId, message.targetId).then(sendResponse);
      return true;
    }
    if (message.type === 'playback:pause') {
      sendResponse({ ok: mounted?.pause(message.sessionId, message.targetId) ?? false });
      return;
    }
    if (message.type === 'playback:prompt') {
      sendResponse({ ok: mounted?.promptForPlayback(message.sessionId, message.targetId) ?? false });
      return;
    }
    if (message.type === 'playback:dispose') {
      sendResponse({ ok: mounted?.disposePlayback(message.sessionId, message.targetId) ?? false });
    }
  });
}

function findResolvedElement(
  elements: readonly Element[],
  target: VideoTarget
): Element | undefined {
  const pageElements = elements.filter((element) => !isVoiceVacOverlay(element));
  if (target.kind === 'html-media') {
    return pageElements.find((element) => element.getAttribute(TARGET_ATTRIBUTE) === target.id);
  }
  return pageElements.find((element) => (
    elementMatchesTargetKind(element, target.kind)
      && sameRect(element.getBoundingClientRect(), target.viewportRect)
  ));
}

function elementMatchesTargetKind(
  element: Element,
  kind: VideoTarget['kind']
): boolean {
  const tag = element.tagName.toLowerCase();
  if (kind === 'html-media') return false;
  if (kind === 'embedded-player') {
    return tag === 'iframe' || tag === 'embed' || tag === 'object';
  }
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
  return MEDIA_TARGET_SEMANTICS.test(semantics);
}

function isVoiceVacOverlay(element: Element): boolean {
  const selector = `#${ROOT_ID}, .voice-vac-drop-catcher, [data-voice-vac-overlay]`;
  return element.matches(selector) || element.closest(selector) !== null;
}

function sameRect(rect: DOMRect | DOMRectReadOnly, expected: TargetRect): boolean {
  const x = Number.isFinite(rect.x) ? rect.x : rect.left;
  const y = Number.isFinite(rect.y) ? rect.y : rect.top;
  return x === expected.x
    && y === expected.y
    && rect.width === expected.width
    && rect.height === expected.height;
}

function promptPosition(rect: TargetRect): Record<string, string> {
  return {
    left: `${Math.max(12, rect.x + rect.width / 2)}px`,
    top: `${Math.max(12, rect.y + Math.min(rect.height * 0.18, 72))}px`,
    transform: 'translate(-50%, -50%)'
  };
}

function hasPlainText(types: readonly string[] | DOMStringList | undefined): boolean {
  return types ? Array.from(types).includes('text/plain') : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (typeof chrome !== 'undefined'
  && typeof document !== 'undefined'
  && typeof chrome.runtime?.onMessage?.addListener === 'function') {
  registerContentTunnelRuntime();
}
