// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountContentTunnel } from '../src/content-tunnel.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Voice Vac page tunnel', () => {
  it('mounts a compact machine with the shared semantic controls', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      active: false,
      mode: 'quality',
      phase: 'idle'
    });
    const storageListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: storageListener } }
    });

    const tunnel = mountContentTunnel();
    expect(document.querySelector('#vacvox-tunnel-root')).toBeTruthy();
    expect(tunnel.host.querySelector('[aria-label="连接到视频"]')).toBeTruthy();
    expect(tunnel.host.querySelector('[aria-label="检测视频"]')).toBeTruthy();
    expect(tunnel.host.textContent).toContain('复制全文');
    expect(sendMessage).toHaveBeenCalledWith({ target: 'service-worker', type: 'capture-state:get' });
  });

  it('reports a selected video when the suction head is dropped over it', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ active: false, mode: 'quality', phase: 'idle' });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage },
      storage: { onChanged: { addListener: vi.fn() } }
    });
    const video = document.createElement('video');
    Object.defineProperty(video, 'getBoundingClientRect', {
      value: () => ({ left: 10, top: 10, right: 310, bottom: 190, width: 300, height: 180 })
    });
    document.body.append(video);
    const tunnel = mountContentTunnel();
    const head = tunnel.host.querySelector('[aria-label="连接到视频"]') as HTMLElement;

    head.dispatchEvent(pointerEvent('pointerdown', 50, 50));
    document.dispatchEvent(pointerEvent('pointermove', 100, 100));
    document.dispatchEvent(pointerEvent('pointerup', 100, 100));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      target: 'service-worker',
      type: 'target:ready',
      url: window.location.href
    }));
  });
});

function pointerEvent(type: string, clientX: number, clientY: number): Event {
  const event = new Event(type, { bubbles: true });
  Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY }, pointerId: { value: 1 } });
  return event;
}
