import { describe, expect, it, vi } from 'vitest';

import {
  ExtensionCommandBroker,
  type ExtensionCommandEnvelope
} from '../src/extension-command-broker.js';

const START_COMMAND: ExtensionCommandEnvelope = {
  protocolVersion: 2,
  commandId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  type: 'capture-start',
  issuedAt: 1_000
};

describe('ExtensionCommandBroker', () => {
  it('returns commands once after a monotonic cursor and copies every boundary', () => {
    const broker = new ExtensionCommandBroker();
    const input = { ...START_COMMAND };
    const published = broker.publish(input);
    input.type = 'capture-stop';

    expect(published).toEqual(START_COMMAND);
    expect(broker.readAfter(0)).toEqual({ cursor: 1, commands: [START_COMMAND] });
    expect(broker.readAfter(1)).toEqual({ cursor: 1, commands: [] });

    const first = broker.readAfter(0);
    first.commands[0]!.type = 'capture-stop';
    expect(broker.readAfter(0).commands[0]!.type).toBe('capture-start');
  });

  it('wakes one bounded waiter when a command is published', async () => {
    vi.useFakeTimers();
    try {
      const broker = new ExtensionCommandBroker();
      const waiting = broker.waitAfter(0, 20_000);
      const command = broker.publish({ ...START_COMMAND, type: 'capture-pause' });
      await expect(waiting).resolves.toEqual({ cursor: 1, commands: [command] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out without leaking a waiter', async () => {
    vi.useFakeTimers();
    try {
      const broker = new ExtensionCommandBroker();
      const waiting = broker.waitAfter(0, 500);
      await vi.advanceTimersByTimeAsync(500);
      await expect(waiting).resolves.toEqual({ cursor: 0, commands: [] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an abandoned waiter and clears its timer immediately', async () => {
    vi.useFakeTimers();
    try {
      const broker = new ExtensionCommandBroker();
      const controller = new AbortController();
      const waiting = broker.waitAfter(0, 20_000, controller.signal);
      expect(vi.getTimerCount()).toBe(1);

      controller.abort();

      await expect(waiting).resolves.toEqual({ cursor: 0, commands: [] });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps only the newest 256 commands and recovers a stale cursor', () => {
    const broker = new ExtensionCommandBroker();
    for (let index = 0; index < 300; index += 1) {
      broker.publish({
        ...START_COMMAND,
        commandId: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
        issuedAt: index
      });
    }

    const batch = broker.readAfter(0);
    expect(batch.cursor).toBe(300);
    expect(batch.commands).toHaveLength(256);
    expect(batch.commands[0]!.issuedAt).toBe(44);
    expect(batch.commands.at(-1)!.issuedAt).toBe(299);
  });

  it('resolves all waiters and rejects future publishing after close', async () => {
    const broker = new ExtensionCommandBroker();
    const first = broker.waitAfter(0, 20_000);
    const second = broker.waitAfter(0, 20_000);
    broker.close();

    await expect(first).resolves.toEqual({ cursor: 0, commands: [] });
    await expect(second).resolves.toEqual({ cursor: 0, commands: [] });
    expect(() => broker.publish(START_COMMAND)).toThrow('closed');
  });
});
