import { describe, expect, it, vi } from 'vitest';

import {
  createNativeCommandChannel,
  VOIVOX_NATIVE_HOST,
  type NativeCommand,
  type NativeCommandPort
} from '../src/native-command-channel.js';

const chromePortIsCompatible = (port: chrome.runtime.Port): NativeCommandPort => port;
void chromePortIsCompatible;

type Listener<T> = (value: T) => void;

class EventHarness<T> {
  readonly listeners = new Set<Listener<T>>();

  addListener = (listener: Listener<T>): void => {
    this.listeners.add(listener);
  };

  removeListener = (listener: Listener<T>): void => {
    this.listeners.delete(listener);
  };

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}

function nativePortHarness() {
  const messages = new EventHarness<unknown>();
  const disconnects = new EventHarness<unknown>();
  const port: NativeCommandPort = {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: messages,
    onDisconnect: disconnects
  };
  return {
    port,
    emit: (value: unknown) => messages.emit(value),
    emitDisconnect: () => disconnects.emit(undefined),
    listenerCounts: () => ({
      disconnect: disconnects.listeners.size,
      message: messages.listeners.size
    })
  };
}

function command(
  type: NativeCommand['type'] = 'capture-start',
  overrides: Partial<NativeCommand> = {}
): NativeCommand {
  return {
    protocolVersion: 2,
    commandId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    type,
    issuedAt: 1_000,
    ...overrides
  };
}

function commandId(index: number): string {
  return `11111111-1111-4111-8111-${index.toString().padStart(12, '0')}`;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('native command channel', () => {
  it('connects to the exact host, handshakes with protocol two, and dispatches a command once', async () => {
    const harness = nativePortHarness();
    const connectNative = vi.fn(() => harness.port);
    const dispatch = vi.fn(async () => undefined);
    const channel = createNativeCommandChannel({ connectNative, dispatch });

    channel.start();

    expect(connectNative).toHaveBeenCalledOnce();
    expect(connectNative).toHaveBeenCalledWith(VOIVOX_NATIVE_HOST);
    expect(harness.port.postMessage).toHaveBeenCalledWith({
      protocolVersion: 2,
      type: 'connect'
    });

    harness.emit({ protocolVersion: 2, service: 'voivox', status: 'connected' });
    harness.emit(command());
    harness.emit(command());
    await flushPromises();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(command());
  });

  it('accepts only the exact protocol-two command envelope', async () => {
    const harness = nativePortHarness();
    const dispatch = vi.fn(async () => undefined);
    const channel = createNativeCommandChannel({
      connectNative: () => harness.port,
      dispatch
    });
    channel.start();
    harness.emit({ protocolVersion: 2, service: 'voivox', status: 'connected' });

    const valid = command('capture-pause', {
      commandId: '33333333-3333-4333-8333-333333333333'
    });
    const invalid: unknown[] = [
      null,
      [],
      { ...valid, protocolVersion: 1 },
      { ...valid, commandId: 'not-a-uuid' },
      { ...valid, sessionId: 'not-a-uuid' },
      { ...valid, type: 'capture-rewind' },
      { ...valid, issuedAt: Number.NaN },
      { ...valid, issuedAt: '1000' },
      { ...valid, token: 'must-not-cross-native-messaging' },
      {
        protocolVersion: 2,
        commandId: valid.commandId,
        sessionId: valid.sessionId,
        type: valid.type
      }
    ];

    for (const value of invalid) harness.emit(value);
    harness.emit(valid);
    await flushPromises();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(valid);
  });

  it('serializes command dispatch even when messages arrive together', async () => {
    const harness = nativePortHarness();
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const observed: string[] = [];
    const dispatch = vi.fn(async (value: NativeCommand) => {
      observed.push(`start:${value.type}`);
      if (value.type === 'capture-start') await firstPending;
      observed.push(`end:${value.type}`);
    });
    const channel = createNativeCommandChannel({
      connectNative: () => harness.port,
      dispatch
    });
    channel.start();
    harness.emit({ protocolVersion: 2, service: 'voivox', status: 'connected' });

    harness.emit(command('capture-start'));
    harness.emit(command('capture-stop', {
      commandId: '33333333-3333-4333-8333-333333333333'
    }));
    await flushPromises();

    expect(observed).toEqual(['start:capture-start']);
    releaseFirst?.();
    await flushPromises();
    expect(observed).toEqual([
      'start:capture-start',
      'end:capture-start',
      'start:capture-stop',
      'end:capture-stop'
    ]);
  });

  it('bounds de-duplication to the most recent 512 command IDs', async () => {
    const harness = nativePortHarness();
    const dispatch = vi.fn(async () => undefined);
    const channel = createNativeCommandChannel({
      connectNative: () => harness.port,
      dispatch
    });
    channel.start();
    harness.emit({ protocolVersion: 2, service: 'voivox', status: 'connected' });

    for (let index = 0; index < 513; index += 1) {
      harness.emit(command('capture-start', { commandId: commandId(index) }));
    }
    harness.emit(command('capture-start', { commandId: commandId(0) }));
    await flushPromises();

    expect(dispatch).toHaveBeenCalledTimes(514);
  });

  it('reconnects exponentially from 250 ms up to 30 seconds with one live port', async () => {
    vi.useFakeTimers();
    try {
      const ports = Array.from({ length: 10 }, () => nativePortHarness());
      let portIndex = 0;
      const connectNative = vi.fn(() => ports[portIndex++]!.port);
      const channel = createNativeCommandChannel({
        connectNative,
        dispatch: async () => undefined
      });
      channel.start();

      const delays = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
      for (let index = 0; index < delays.length; index += 1) {
        ports[index]!.emitDisconnect();
        ports[index]!.emitDisconnect();
        expect(ports[index]!.listenerCounts()).toEqual({ disconnect: 0, message: 0 });
        await vi.advanceTimersByTimeAsync(delays[index]! - 1);
        expect(connectNative).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(connectNative).toHaveBeenCalledTimes(index + 2);
      }

      expect(ports.slice(0, -1).every(({ port }) =>
        vi.mocked(port.disconnect).mock.calls.length === 0)).toBe(true);
      expect(ports.at(-1)?.listenerCounts()).toEqual({ disconnect: 1, message: 1 });
      channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets reconnect backoff only after an exact connected handshake', async () => {
    vi.useFakeTimers();
    try {
      const first = nativePortHarness();
      const second = nativePortHarness();
      const third = nativePortHarness();
      const fourth = nativePortHarness();
      const ports = [first, second, third, fourth];
      let portIndex = 0;
      const connectNative = vi.fn(() => ports[portIndex++]!.port);
      const channel = createNativeCommandChannel({
        connectNative,
        dispatch: async () => undefined
      });
      channel.start();

      first.emitDisconnect();
      await vi.advanceTimersByTimeAsync(250);
      second.emitDisconnect();
      await vi.advanceTimersByTimeAsync(500);

      third.emit({
        protocolVersion: 2,
        service: 'voivox',
        status: 'connected',
        unexpected: true
      });
      third.emitDisconnect();
      await vi.advanceTimersByTimeAsync(999);
      expect(connectNative).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(connectNative).toHaveBeenCalledTimes(4);

      fourth.emit({ protocolVersion: 2, service: 'voivox', status: 'connected' });
      fourth.emitDisconnect();
      await vi.advanceTimersByTimeAsync(249);
      expect(connectNative).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(connectNative).toHaveBeenCalledTimes(5);
      channel.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores commands until that port sends the exact connected handshake', async () => {
    const harness = nativePortHarness();
    const dispatch = vi.fn(async () => undefined);
    const channel = createNativeCommandChannel({
      connectNative: () => harness.port,
      dispatch
    });
    channel.start();

    const first = command();
    harness.emit(first);
    harness.emit({
      protocolVersion: 2,
      service: 'voivox',
      status: 'connected',
      unexpected: true
    });
    harness.emit(first);
    await flushPromises();
    expect(dispatch).not.toHaveBeenCalled();

    harness.emit({ protocolVersion: 2, service: 'voivox', status: 'connected' });
    harness.emit(first);
    harness.emit(first);
    await flushPromises();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('keeps one serial barrier across stop and restart while skipping stale queued commands', async () => {
    const firstPort = nativePortHarness();
    const secondPort = nativePortHarness();
    const ports = [firstPort, secondPort];
    let portIndex = 0;
    let releaseFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const observed: string[] = [];
    const dispatch = vi.fn(async (value: NativeCommand) => {
      observed.push(`start:${value.type}`);
      if (value.type === 'capture-start') await firstPending;
      observed.push(`end:${value.type}`);
    });
    const channel = createNativeCommandChannel({
      connectNative: () => ports[portIndex++]!.port,
      dispatch
    });

    channel.start();
    firstPort.emit({ protocolVersion: 2, service: 'voivox', status: 'connected' });
    firstPort.emit(command('capture-start'));
    firstPort.emit(command('capture-stop', {
      commandId: '33333333-3333-4333-8333-333333333333'
    }));
    await flushPromises();
    expect(observed).toEqual(['start:capture-start']);

    channel.stop();
    channel.start();
    secondPort.emit({ protocolVersion: 2, service: 'voivox', status: 'connected' });
    secondPort.emit(command('capture-resume', {
      commandId: '44444444-4444-4444-8444-444444444444'
    }));
    await flushPromises();
    expect(observed).toEqual(['start:capture-start']);

    releaseFirst?.();
    await flushPromises();
    expect(observed).toEqual([
      'start:capture-start',
      'end:capture-start',
      'start:capture-resume',
      'end:capture-resume'
    ]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('finishes stop cleanup even when the native port disconnect throws', () => {
    const first = nativePortHarness();
    const second = nativePortHarness();
    vi.mocked(first.port.disconnect).mockImplementation(() => {
      throw new Error('native host already exited');
    });
    const connectNative = vi.fn()
      .mockReturnValueOnce(first.port)
      .mockReturnValueOnce(second.port);
    const channel = createNativeCommandChannel({
      connectNative,
      dispatch: async () => undefined
    });

    channel.start();
    expect(() => channel.stop()).not.toThrow();
    expect(first.listenerCounts()).toEqual({ disconnect: 0, message: 0 });
    expect(() => channel.start()).not.toThrow();
    expect(connectNative).toHaveBeenCalledTimes(2);
    channel.stop();
  });

  it('makes start idempotent and stop remove the port and pending reconnect timer', async () => {
    vi.useFakeTimers();
    try {
      const first = nativePortHarness();
      const second = nativePortHarness();
      const connectNative = vi.fn()
        .mockReturnValueOnce(first.port)
        .mockReturnValueOnce(second.port);
      const dispatch = vi.fn(async () => undefined);
      const channel = createNativeCommandChannel({ connectNative, dispatch });

      channel.start();
      channel.start();
      expect(connectNative).toHaveBeenCalledOnce();
      channel.stop();
      channel.stop();
      expect(first.port.disconnect).toHaveBeenCalledOnce();
      expect(first.listenerCounts()).toEqual({ disconnect: 0, message: 0 });

      first.emit(command());
      first.emitDisconnect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connectNative).toHaveBeenCalledOnce();
      expect(dispatch).not.toHaveBeenCalled();

      channel.start();
      second.emitDisconnect();
      channel.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(connectNative).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
