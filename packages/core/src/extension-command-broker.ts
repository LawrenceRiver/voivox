export const EXTENSION_COMMAND_TYPES = [
  'drag-begin',
  'drag-cancel',
  'capture-start',
  'capture-pause',
  'capture-resume',
  'capture-stop',
  'target-disconnect'
] as const;

export type ExtensionCommandType = typeof EXTENSION_COMMAND_TYPES[number];

export type ExtensionCommandEnvelope = {
  protocolVersion: 2;
  commandId: string;
  sessionId: string;
  type: ExtensionCommandType;
  issuedAt: number;
};

export type ExtensionCommandBatch = {
  cursor: number;
  commands: ExtensionCommandEnvelope[];
};

type CommandEntry = {
  cursor: number;
  command: ExtensionCommandEnvelope;
};

type CommandWaiter = {
  after: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (batch: ExtensionCommandBatch) => void;
  signal?: AbortSignal;
  abort?: () => void;
};

const MAXIMUM_RETAINED_COMMANDS = 256;

/**
 * Bounded, in-memory command fan-out between the primary desktop authority and
 * the restricted Chrome native host. Cursors are process-local and monotonic;
 * command identifiers provide the durable idempotency boundary for consumers.
 */
export class ExtensionCommandBroker {
  private readonly entries: CommandEntry[] = [];
  private readonly waiters = new Set<CommandWaiter>();
  private cursor = 0;
  private closed = false;

  publish(input: ExtensionCommandEnvelope): ExtensionCommandEnvelope {
    if (this.closed) throw new Error('Voice VAC extension command broker is closed.');
    const command = cloneCommand(input);
    this.cursor += 1;
    this.entries.push({ cursor: this.cursor, command });
    if (this.entries.length > MAXIMUM_RETAINED_COMMANDS) {
      this.entries.splice(0, this.entries.length - MAXIMUM_RETAINED_COMMANDS);
    }
    this.resolveReadyWaiters();
    return cloneCommand(command);
  }

  readAfter(after: number): ExtensionCommandBatch {
    assertCursor(after);
    return {
      cursor: this.cursor,
      commands: this.entries
        .filter((entry) => entry.cursor > after)
        .map((entry) => cloneCommand(entry.command))
    };
  }

  waitAfter(
    after: number,
    waitMs: number,
    signal?: AbortSignal
  ): Promise<ExtensionCommandBatch> {
    assertCursor(after);
    if (!Number.isFinite(waitMs) || waitMs < 0) {
      throw new Error('Voice VAC extension command wait must be a nonnegative duration.');
    }
    const immediate = this.readAfter(after);
    if (this.closed || signal?.aborted || immediate.commands.length > 0 || waitMs === 0) {
      return Promise.resolve(immediate);
    }

    return new Promise((resolve) => {
      const waiter: CommandWaiter = {
        after,
        resolve,
        timer: setTimeout(() => this.settleWaiter(waiter), waitMs),
        ...(signal ? { signal } : {})
      };
      if (signal) {
        waiter.abort = () => this.settleWaiter(waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiters.add(waiter);
      if (signal?.aborted) this.settleWaiter(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.waiters]) {
      this.settleWaiter(waiter);
    }
  }

  private resolveReadyWaiters(): void {
    for (const waiter of [...this.waiters]) {
      if (this.cursor > waiter.after) this.settleWaiter(waiter);
    }
  }

  private settleWaiter(waiter: CommandWaiter): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener('abort', waiter.abort);
    }
    waiter.resolve(this.readAfter(waiter.after));
  }
}

function assertCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Voice VAC extension command cursor must be a nonnegative safe integer.');
  }
}

function cloneCommand(command: ExtensionCommandEnvelope): ExtensionCommandEnvelope {
  return {
    protocolVersion: command.protocolVersion,
    commandId: command.commandId,
    sessionId: command.sessionId,
    type: command.type,
    issuedAt: command.issuedAt
  };
}
