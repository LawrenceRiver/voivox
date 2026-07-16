// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App, type DesktopClient } from '../src/renderer/app.js';

afterEach(cleanup);

describe('VOIVOX desktop app', () => {
  it('reveals the Chrome bridge instead of creating an empty desktop session', async () => {
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({ activeSession: undefined, sessions: [] }),
      startCapture: vi.fn().mockResolvedValue({ id: 'session_1', status: 'capturing' }),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn(),
      getChromeBridge: vi.fn().mockResolvedValue({
        baseUrl: 'http://127.0.0.1:46666',
        token: 'restricted-chrome-bridge-token'
      })
    };

    render(<App desktopClient={client} />);

    expect(await screen.findByText('准备就绪')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '在扩展中开始' }));

    expect(client.startCapture).not.toHaveBeenCalled();
    expect(await screen.findByDisplayValue('http://127.0.0.1:46666')).toBeTruthy();
    expect(screen.getByText('请在 Chrome 扩展中点击“开始静音收录”。')).toBeTruthy();
  });

  it('reveals a restricted Chrome bridge only after the user asks for it', async () => {
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({ activeSession: undefined, sessions: [] }),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn(),
      getChromeBridge: vi.fn().mockResolvedValue({
        baseUrl: 'http://127.0.0.1:46666',
        token: 'restricted-chrome-bridge-token'
      })
    };

    render(<App desktopClient={client} />);
    fireEvent.click(await screen.findByRole('button', { name: '显示 Chrome 连接' }));

    expect(await screen.findByDisplayValue('http://127.0.0.1:46666')).toBeTruthy();
    expect(await screen.findByDisplayValue('restricted-chrome-bridge-token')).toBeTruthy();
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
    reportAsrError?.('VOIVOX local ASR is not installed.');

    expect(await screen.findByText('VOIVOX local ASR is not installed.')).toBeTruthy();
  });

  it('lets a user select fast local transcription windows before capture', async () => {
    const setCaptureMode = vi.fn().mockResolvedValue(undefined);
    const client: DesktopClient = {
      getDashboard: vi.fn().mockResolvedValue({ activeSession: undefined, sessions: [] }),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
      appendDemoSegment: vi.fn(),
      setCaptureMode
    };

    render(<App desktopClient={client} />);
    fireEvent.click(await screen.findByRole('button', { name: '快速 · 4 秒' }));

    expect(setCaptureMode).toHaveBeenCalledWith('fast');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '快速 · 4 秒' }).getAttribute('aria-pressed')).toBe('true');
    });
  });
});
