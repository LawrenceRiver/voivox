import { normalizeCaptureState, type CaptureState } from './bridge.js';

const ROOT_ID = 'vacvox-tunnel-root';

export type MountedContentTunnel = {
  host: HTMLElement;
  update: (state: CaptureState) => void;
  destroy: () => void;
};

export function mountContentTunnel(): MountedContentTunnel {
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    const host = existing.querySelector<HTMLElement>('[data-vacvox-host]');
    if (host) return { host, update: () => undefined, destroy: () => existing.remove() };
    existing.remove();
  }

  const root = document.createElement('div');
  root.id = ROOT_ID;
  const shadow = root.attachShadow?.({ mode: 'open' }) ?? root;
  const host = document.createElement('div');
  host.dataset.vacvoxHost = 'true';
  host.innerHTML = machineMarkup();
  shadow.append(host);
  document.documentElement.append(root);

  const head = requireElement<HTMLButtonElement>(host, '[data-role="head"]');
  const primary = requireElement<HTMLButtonElement>(host, '[data-role="primary"]');
  const copy = requireElement<HTMLButtonElement>(host, '[data-role="copy"]');
  const close = requireElement<HTMLButtonElement>(host, '[data-role="close"]');
  const status = requireElement<HTMLElement>(host, '[data-role="status"]');
  const transcript = requireElement<HTMLElement>(host, '[data-role="transcript"]');
  const title = requireElement<HTMLElement>(host, '[data-role="title"]');
  const linkOverlay = createLinkOverlay();
  let currentState = normalizeCaptureState(undefined);
  let selectedVideo: HTMLVideoElement | undefined;
  let selectedVideoOutline = '';
  let dragging = false;

  const update = (nextState: CaptureState): void => {
    currentState = nextState;
    const processing = nextState.active || nextState.phase === 'downloading' || nextState.phase === 'transcribing';
    host.classList.toggle('is-processing', processing);
    host.classList.toggle('is-error', nextState.phase === 'error');
    host.classList.toggle('is-ready', nextState.linkState === 'ready');
    status.textContent = statusLabel(nextState.phase);
    title.textContent = nextState.tabTitle ?? document.title ?? '当前视频';
    transcript.textContent = nextState.transcript ?? '文字会从这里出现。';
    primary.setAttribute('aria-label', processing ? '暂停转录' : nextState.phase === 'complete' ? '重新转录' : '检测视频');
    primary.textContent = processing ? 'Ⅱ' : '▶';
    copy.disabled = !nextState.transcript?.trim();
    drawLink();
  };

  function findVideo(clientX: number, clientY: number): HTMLVideoElement | undefined {
    const element = document.elementFromPoint?.(clientX, clientY);
    const candidate = element?.closest?.('video');
    if (candidate instanceof HTMLVideoElement) return candidate;
    return Array.from(document.querySelectorAll('video')).find((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    });
  }

  function highlight(video: HTMLVideoElement | undefined): void {
    if (selectedVideo && selectedVideo !== video) selectedVideo.style.outline = selectedVideoOutline;
    selectedVideo = video;
    if (video) {
      selectedVideoOutline = video.style.outline;
      video.style.outline = '3px solid #90c9dd';
      video.style.outlineOffset = '4px';
    }
    drawLink();
  }

  function targetPayload(video: HTMLVideoElement | undefined): Record<string, unknown> {
    if (!video) return {};
    const rect = video.getBoundingClientRect();
    const screenX = window.screenX || 0;
    const screenY = window.screenY || 0;
    return {
      targetRect: { x: screenX + rect.left, y: screenY + rect.top, width: rect.width, height: rect.height },
      pageEndpoint: { screenX: screenX + rect.left + rect.width * .5, screenY: screenY + rect.top + rect.height * .12 }
    };
  }

  function drawLink(): void {
    if (!selectedVideo) {
      linkOverlay.path.setAttribute('d', '');
      return;
    }
    const headRect = head.getBoundingClientRect();
    const targetRect = selectedVideo.getBoundingClientRect();
    const startX = headRect.left + headRect.width * .5;
    const startY = headRect.top + headRect.height * .5;
    const endX = targetRect.left + targetRect.width * .5;
    const endY = targetRect.top + targetRect.height * .12;
    const bend = Math.max(70, Math.abs(endX - startX) * .28);
    linkOverlay.path.setAttribute('d', `M ${startX} ${startY} C ${startX + bend} ${startY - 18}, ${endX - bend} ${endY + 26}, ${endX} ${endY}`);
    linkOverlay.path.classList.toggle('is-flowing', currentState.active || dragging);
    linkOverlay.target.setAttribute('cx', String(endX));
    linkOverlay.target.setAttribute('cy', String(endY));
  }

  const onMove = (event: PointerEvent): void => {
    if (!dragging) return;
    const video = findVideo(event.clientX, event.clientY);
    highlight(video);
    void chrome.runtime.sendMessage({ target: 'service-worker', type: 'target:preview', ...targetPayload(video) });
  };
  const onUp = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    host.classList.remove('is-dragging');
    const video = findVideo(event.clientX, event.clientY) ?? selectedVideo;
    highlight(video);
    if (video) {
      void chrome.runtime.sendMessage({
        target: 'service-worker',
        type: 'target:ready',
        ...targetPayload(video),
        tabTitle: document.title || '当前视频',
        url: window.location.href
      });
      status.textContent = '已就绪';
    }
  };

  head.addEventListener('pointerdown', (event) => {
    dragging = true;
    host.classList.add('is-dragging');
    head.setPointerCapture?.(event.pointerId);
    highlight(findVideo(event.clientX, event.clientY));
    drawLink();
  });
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  primary.addEventListener('click', () => {
    void chrome.runtime.sendMessage({ target: 'service-worker', type: 'capture:toggle' });
  });
  copy.addEventListener('click', () => {
    if (currentState.transcript) void navigator.clipboard?.writeText(currentState.transcript);
    copy.textContent = '已复制';
    window.setTimeout(() => { copy.textContent = '复制全文'; }, 1_000);
  });
  close.addEventListener('click', () => mounted.destroy());
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.voivoxCaptureState) update(normalizeCaptureState(changes.voivoxCaptureState.newValue));
  });

  const mounted: MountedContentTunnel = {
    host,
    update,
    destroy: () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      window.removeEventListener('resize', drawLink);
      window.removeEventListener('scroll', drawLink, true);
      if (selectedVideo) {
        selectedVideo.style.outline = selectedVideoOutline;
        selectedVideo.style.removeProperty('outline-offset');
      }
      linkOverlay.svg.remove();
      root.remove();
    }
  };
  window.addEventListener('resize', drawLink);
  window.addEventListener('scroll', drawLink, true);
  update(currentState);
  void chrome.runtime.sendMessage({ target: 'service-worker', type: 'capture-state:get' })
    .then((value: unknown) => update(normalizeCaptureState(value)))
    .catch(() => undefined);
  return mounted;
}

function createLinkOverlay(): {
  svg: SVGSVGElement;
  path: SVGPathElement;
  target: SVGCircleElement;
} {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
  Object.assign(svg.style, {
    height: '100vh',
    left: '0',
    pointerEvents: 'none',
    position: 'fixed',
    top: '0',
    width: '100vw',
    zIndex: '2147483646'
  });
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#94c9da');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-width', '12');
  path.setAttribute('opacity', '.74');
  path.style.filter = 'drop-shadow(0 3px 6px rgb(73 112 127 / 25%))';
  const target = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  target.setAttribute('fill', '#ffffff');
  target.setAttribute('stroke', '#94c9da');
  target.setAttribute('stroke-width', '3');
  target.setAttribute('r', '7');
  svg.append(path, target);
  document.documentElement.append(svg);
  return { svg, path, target };
}

function machineMarkup(): string {
  const stylesheetUrl = typeof chrome.runtime.getURL === 'function'
    ? chrome.runtime.getURL('content-tunnel.css')
    : 'content-tunnel.css';
  return `
    <link rel="stylesheet" href="${stylesheetUrl}">
    <div class="vacvox-machine" role="region" aria-label="Voice Vac PVTT">
      <button class="vacvox-close" data-role="close" aria-label="关闭">×</button>
      <div class="vacvox-plaque"><span></span>PVTT<small>PRIVATE AUDIO</small></div>
      <div class="vacvox-stage">
      <div class="vacvox-intake">
        <button class="vacvox-head" data-role="head" aria-label="连接到视频"><i></i><i></i><b></b></button>
        <small>吸音头</small>
      </div>
      <div class="vacvox-hose"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="vacvox-control">
        <button class="vacvox-primary" data-role="primary" aria-label="检测视频">▶</button>
        <span class="vacvox-status" data-role="status" aria-live="polite">检测视频</span>
      </div>
      <div class="vacvox-hose vacvox-hose--out"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="vacvox-output">
        <div class="vacvox-output-head"><div><small>字幕输出舱</small><strong data-role="title">当前视频</strong></div><span>自动</span></div>
        <div class="vacvox-transcript" data-role="transcript" aria-live="polite">文字会从这里出现。</div>
        <button class="vacvox-copy" data-role="copy" disabled>复制全文</button>
      </div>
      </div>
      <div class="vacvox-footnote"><span></span>目标标签页静音 · 其他声音保持不变</div>
    </div>`;
}

function statusLabel(phase: CaptureState['phase']): string {
  const labels: Record<CaptureState['phase'], string> = {
    idle: '检测视频',
    armed: '已武装',
    connecting: '正在连接',
    'awaiting-user-play': '等待播放',
    capturing: '正在连接',
    paused: '已暂停',
    downloading: '正在准备',
    transcribing: '正在转录',
    complete: '已完成',
    error: '失败'
  };
  return labels[phase];
}

function requireElement<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`Voice Vac tunnel element is missing: ${selector}`);
  return element as T;
}

if (typeof chrome !== 'undefined' && typeof document !== 'undefined') {
  mountContentTunnel();
}
