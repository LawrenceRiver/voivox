// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TunnelMachine } from '../src/TunnelMachine.js';

afterEach(cleanup);

const baseProps = {
  size: 'full' as const,
  locale: 'zh-CN' as const,
  state: 'ready' as const,
  source: { title: '我的视频', url: 'https://example.com/video' },
  mode: 'auto' as const,
  segments: [{ start: 0, end: 2, text: '这是第一段字幕。' }],
  transcript: '这是第一段字幕。',
  onModeChange: vi.fn(),
  onPrimaryAction: vi.fn(),
  onStop: vi.fn(),
  onCopy: vi.fn(),
  onClear: vi.fn(),
  onRetry: vi.fn()
};

describe('shared tunnel machine', () => {
  it('keeps the same semantic controls in full and compact sizes', () => {
    const { rerender } = render(<TunnelMachine {...baseProps} />);
    expect(screen.getByRole('button', { name: '开始转录' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制全文' })).toBeTruthy();

    rerender(<TunnelMachine {...baseProps} size="compact" />);
    expect(screen.getByRole('button', { name: '开始转录' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制全文' })).toBeTruthy();
  });

  it('maps state to the central control and output status', () => {
    const onPrimaryAction = vi.fn();
    render(<TunnelMachine {...baseProps} state="transcribing" onPrimaryAction={onPrimaryAction} />);

    const pause = screen.getByRole('button', { name: '暂停转录' });
    expect(screen.getByText('正在转录')).toBeTruthy();
    fireEvent.click(pause);
    expect(onPrimaryAction).toHaveBeenCalledTimes(1);
  });

  it('copies only transcript content and exposes the target as a droppable region', () => {
    const onCopy = vi.fn();
    render(<TunnelMachine {...baseProps} onCopy={onCopy} />);

    expect(screen.getByText('我的视频')).toBeTruthy();
    expect(screen.getByRole('button', { name: '连接到视频' })).toBeTruthy();
    expect(document.querySelector('canvas[data-engine="three.js r177"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制全文' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('uses the monitor size to return results to Codex without clipboard controls', () => {
    render(<TunnelMachine {...baseProps} locale="en" size="monitor" state="returning" />);

    expect(screen.getByRole('button', { name: 'Returning' })).toBeTruthy();
    expect(screen.getByText('Returned to Codex when complete')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy full transcript' })).toBeNull();
  });
});
