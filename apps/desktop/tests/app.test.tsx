// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App, type DesktopClient } from '../src/renderer/app.js';

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value)
    }
  });
  window.localStorage.clear();
  window.localStorage.setItem('voivoxLocale', 'zh-CN');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.useRealTimers();
});

describe('Voice Vac desktop app', () => {
  it('uses the shared PVTT machine as the primary monitor surface', async () => {
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({ activeSession: undefined, sessions: [] }),
      getCapabilities: vi.fn().mockResolvedValue({ extensionDiscovery: true, localAsr: 'ready' }),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn()
    };

    render(<App desktopClient={client} />);

    expect(await screen.findByText('字幕输出舱')).toBeTruthy();
    expect(screen.getByRole('button', { name: '连接到视频' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '检测视频' })).toBeTruthy();
  });

  it('shows the compact capsule and automatic local connection states without secrets', async () => {
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({ activeSession: undefined, sessions: [] }),
      getCapabilities: vi.fn().mockResolvedValue({ extensionDiscovery: true, localAsr: 'ready' }),
      startCapture: vi.fn().mockResolvedValue({ id: 'session_1', status: 'capturing' }),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn()
    };

    render(<App desktopClient={client} />);

    expect(await screen.findByText('字幕输出舱')).toBeTruthy();
    expect(screen.getByText('01 · 声音来源')).toBeTruthy();
    expect(screen.queryByText('01 · SOURCE')).toBeNull();
    expect(screen.getByText('PVTT')).toBeTruthy();
    expect(await screen.findByText('App 转写运行时已发现')).toBeTruthy();
    expect(screen.getByText('扩展自动连接')).toBeTruthy();
    expect(screen.getByText('MCP 服务已就绪')).toBeTruthy();
    expect(screen.queryByLabelText('本机地址')).toBeNull();
    expect(screen.queryByText(/token|token/i)).toBeNull();
  });

  it('switches the complete interface to English and persists the choice', async () => {
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({ activeSession: undefined, sessions: [] }),
      getCapabilities: vi.fn().mockResolvedValue({ extensionDiscovery: false, localAsr: 'missing' }),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn()
    };

    render(<App desktopClient={client} />);
    fireEvent.click(await screen.findByRole('button', { name: '切换到 English' }));

    expect(await screen.findByText('TRANSCRIPT BAY')).toBeTruthy();
    expect(screen.getByText('01 · SOURCE')).toBeTruthy();
    expect(screen.getByText('Waiting for App')).toBeTruthy();
    expect(window.localStorage.getItem('voivoxLocale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('shows a local ASR installation error instead of silently completing an empty transcript', async () => {
    let reportAsrError: ((message: string) => void) | undefined;
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({ activeSession: undefined, sessions: [] }),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn(),
      onAsrError: (listener) => {
        reportAsrError = listener;
        return () => undefined;
      }
    };

    render(<App desktopClient={client} />);
    expect(await screen.findByText('准备就绪')).toBeTruthy();
    reportAsrError?.('Voice Vac local ASR is not installed.');

    expect(await screen.findByText('Voice Vac local ASR is not installed.')).toBeTruthy();
  });

  it('does not expose or call the inert desktop capture-mode control for either source', async () => {
    const setCaptureMode = vi.fn().mockResolvedValue(undefined);
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({ activeSession: undefined, sessions: [] }),
      getCapabilities: vi.fn().mockResolvedValue({ extensionDiscovery: true, localAsr: 'ready' }),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn(),
      setCaptureMode,
      listMacProcesses: vi.fn().mockResolvedValue([
        { bundleId: 'com.apple.Music', name: 'Music', pid: 42 }
      ])
    };

    render(<App desktopClient={client} />);
    const capturePanel = (await screen.findByRole('heading', { name: 'Chrome 标签页' })).closest('.capture-stage');
    const transcriptPanel = screen.getByRole('heading', { name: '原始转写' }).closest('.transcript-panel');

    expect(screen.queryByText('03 · 模型窗口')).toBeNull();
    expect(screen.queryByRole('button', { name: '快速 · 4 秒' })).toBeNull();
    expect(capturePanel?.nextElementSibling).toBe(transcriptPanel);

    fireEvent.click(await screen.findByRole('button', { name: /macOS 应用/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Music/ }));

    expect(await screen.findByRole('heading', { name: 'Music' })).toBeTruthy();
    expect(screen.queryByText('03 · 模型窗口')).toBeNull();
    expect(screen.queryByRole('button', { name: '快速 · 4 秒' })).toBeNull();
    expect(screen.queryByRole('button', { name: '高质量 · 8 秒' })).toBeNull();
    expect(setCaptureMode).not.toHaveBeenCalled();
  });

  it('marks macOS app capture experimental and never starts Chrome capture from the App', async () => {
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({ activeSession: undefined, sessions: [] }),
      getCapabilities: vi.fn().mockResolvedValue({ extensionDiscovery: true, localAsr: 'ready' }),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn()
    };

    render(<App desktopClient={client} />);

    expect(await screen.findByText('实验性')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在 Chrome 扩展中开始' }));

    expect(client.startCapture).not.toHaveBeenCalled();
    expect(await screen.findByText('请在 Chrome 工具栏打开 Voice Vac，然后点击“转写当前标签页”。')).toBeTruthy();
  });

  it('polls for extension-imported sessions without clearing a visible ASR error', async () => {
    vi.useFakeTimers();
    let reportAsrError: ((message: string) => void) | undefined;
    const getDashboard = vi.fn()
      .mockResolvedValueOnce({ activeSession: undefined, sessions: [] })
      .mockResolvedValue({
        activeSession: undefined,
        sessions: [{
          id: 'external_1',
          source: { kind: 'chrome-tab', label: 'Imported Chrome tab' },
          status: 'complete',
          rawSegments: [{ startMs: 0, endMs: 1_500, text: 'Imported extension transcript.' }]
        }]
      });
    const client: DesktopClient = {
      getDashboard,
      getCapabilities: vi.fn().mockResolvedValue({ extensionDiscovery: true, localAsr: 'ready' }),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn(),
      onAsrError: (listener) => {
        reportAsrError = listener;
        return () => undefined;
      }
    };

    render(<App desktopClient={client} />);
    await act(async () => Promise.resolve());
    act(() => reportAsrError?.('Local ASR stopped unexpectedly.'));

    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(getDashboard).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Local ASR stopped unexpectedly.')).toBeTruthy();
    expect(screen.getByText('Imported extension transcript.')).toBeTruthy();
    expect(screen.getByText('原始转写已保存到本机')).toBeTruthy();
  });

  it('keeps the latest completed transcript visible and lets the user reopen older sessions', async () => {
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({
        activeSession: undefined,
        sessions: [
          {
            id: 'latest',
            source: { kind: 'chrome-tab', label: 'Latest video' },
            status: 'complete',
            rawSegments: [{ startMs: 0, endMs: 1_000, text: 'Latest transcript text.' }]
          },
          {
            id: 'older',
            source: { kind: 'macos-process', label: 'Older music app', processId: 9 },
            status: 'complete',
            rawSegments: [{ startMs: 0, endMs: 900, text: 'Older transcript text.' }]
          }
        ]
      }),
      getCapabilities: vi.fn().mockResolvedValue({ extensionDiscovery: true, localAsr: 'ready' }),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn()
    };

    render(<App desktopClient={client} />);

    expect(await screen.findByText('Latest transcript text.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Older music app/ }));
    expect(screen.getByText('Older transcript text.')).toBeTruthy();
  });

  it('shows an active capture ahead of a previously selected completed session', async () => {
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({
        activeSession: {
          id: 'live',
          source: { kind: 'macos-process', label: 'Live player', processId: 7 },
          status: 'capturing',
          rawSegments: [{ startMs: 0, endMs: 600, text: 'Live capture text.' }]
        },
        sessions: [{
          id: 'complete',
          source: { kind: 'chrome-tab', label: 'Older tab' },
          status: 'complete',
          rawSegments: [{ startMs: 0, endMs: 900, text: 'Completed transcript text.' }]
        }]
      }),
      getCapabilities: vi.fn().mockResolvedValue({ extensionDiscovery: true, localAsr: 'ready' }),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn()
    };

    render(<App desktopClient={client} />);

    expect(await screen.findByText('Live capture text.')).toBeTruthy();
    expect(screen.queryByText('Completed transcript text.')).toBeNull();
  });
});
