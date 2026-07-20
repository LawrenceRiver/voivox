import { VOIVOX_NATIVE_HOST } from './native-discovery.js';

export { VOIVOX_NATIVE_HOST } from './native-discovery.js';

const PROTOCOL_VERSION = 2;
const INITIAL_RECONNECT_DELAY_MS = 250;
const MAXIMUM_RECONNECT_DELAY_MS = 30_000;
const MAXIMUM_REMEMBERED_COMMAND_IDS = 512;

const COMMAND_TYPES = [
  'drag-begin',
  'drag-cancel',
  'capture-start',
  'capture-pause',
  'capture-resume',
  'capture-stop',
  'target-disconnect'
] as const;

const COMMAND_KEYS = new Set([
  'protocolVersion',
  'commandId',
  'sessionId',
  'type',
  'issuedAt'
]);

const CONNECTED_KEYS = new Set(['protocolVersion', 'service', 'status']);

export type NativeCommandType = typeof COMMAND_TYPES[number];

export type NativeCommand = Readonly<{
  protocolVersion: 2;
  commandId: string;
  sessionId: string;
  type: NativeCommandType;
  issuedAt: number;
}>;

export type NativePortEvent<T> = {
  addListener(listener: (value: T) => void): void;
  removeListener(listener: (value: T) => void): void;
};

export type NativeCommandPort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: NativePortEvent<unknown>;
  onDisconnect: NativePortEvent<unknown>;
};

export type NativeCommandChannelDependencies = {
  connectNative(host: string): NativeCommandPort;
  dispatch(command: NativeCommand): void | Promise<void>;
  onDispatchError?(error: unknown, command: NativeCommand): void;
};

export type NativeCommandChannel = {
  start(): void;
  stop(): void;
};

export function createNativeCommandChannel(
  dependencies: NativeCommandChannelDependencies
): NativeCommandChannel {
  let running = false;
  let activePort: NativeCommandPort | undefined;
  let activeListeners: {
    onMessage: (value: unknown) => void;
    onDisconnect: () => void;
  } | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let lifecycle = 0;
  let dispatchTail = Promise.resolve();
  const rememberedCommandIds = new Set<string>();

  const scheduleReconnect = (): void => {
    if (!running || activePort || reconnectTimer) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAXIMUM_RECONNECT_DELAY_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openPort();
    }, delay);
  };

  const remember = (commandId: string): boolean => {
    if (rememberedCommandIds.has(commandId)) return false;
    rememberedCommandIds.add(commandId);
    if (rememberedCommandIds.size > MAXIMUM_REMEMBERED_COMMAND_IDS) {
      const oldest = rememberedCommandIds.values().next().value as string | undefined;
      if (oldest !== undefined) rememberedCommandIds.delete(oldest);
    }
    return true;
  };

  const enqueue = (command: NativeCommand): void => {
    if (!remember(command.commandId)) return;
    const acceptedLifecycle = lifecycle;
    dispatchTail = dispatchTail.then(async () => {
      if (!running || acceptedLifecycle !== lifecycle) return;
      try {
        await dependencies.dispatch(command);
      } catch (error) {
        try {
          dependencies.onDispatchError?.(error, command);
        } catch {
          // Reporting failures must not break later command dispatch.
        }
      }
    });
  };

  const detach = (
    port: NativeCommandPort,
    onMessage: (value: unknown) => void,
    onDisconnect: () => void
  ): void => {
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
  };

  function openPort(): void {
    if (!running || activePort || reconnectTimer) return;

    let port: NativeCommandPort;
    try {
      port = dependencies.connectNative(VOIVOX_NATIVE_HOST);
    } catch {
      scheduleReconnect();
      return;
    }
    activePort = port;
    let connected = false;

    const onMessage = (value: unknown): void => {
      if (port !== activePort || !running) return;
      if (isExactConnectedHandshake(value)) {
        connected = true;
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        return;
      }
      if (!connected) return;
      const command = parseNativeCommand(value);
      if (command) enqueue(command);
    };
    const onDisconnect = (): void => {
      if (port !== activePort) return;
      detach(port, onMessage, onDisconnect);
      activePort = undefined;
      activeListeners = undefined;
      scheduleReconnect();
    };

    activeListeners = { onMessage, onDisconnect };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    try {
      port.postMessage({ protocolVersion: PROTOCOL_VERSION, type: 'connect' });
    } catch {
      detach(port, onMessage, onDisconnect);
      activePort = undefined;
      activeListeners = undefined;
      try {
        port.disconnect();
      } catch {
        // The native port is already unusable.
      }
      scheduleReconnect();
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      lifecycle += 1;
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      openPort();
    },

    stop(): void {
      if (!running) return;
      running = false;
      lifecycle += 1;
      rememberedCommandIds.clear();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const port = activePort;
      const listeners = activeListeners;
      activePort = undefined;
      activeListeners = undefined;
      if (port && listeners) {
        // Removing the listeners before disconnect prevents a reconnect race.
        detach(port, listeners.onMessage, listeners.onDisconnect);
        try {
          port.disconnect();
        } catch {
          // Listener and timer cleanup is complete even if Chrome already closed it.
        }
      }
    }
  };
}

function parseNativeCommand(value: unknown): NativeCommand | undefined {
  if (!isRecord(value) || !hasExactKeys(value, COMMAND_KEYS)) return undefined;
  if (
    value.protocolVersion !== PROTOCOL_VERSION
    || !isCanonicalUuid(value.commandId)
    || !isCanonicalUuid(value.sessionId)
    || !isNativeCommandType(value.type)
    || typeof value.issuedAt !== 'number'
    || !Number.isFinite(value.issuedAt)
  ) {
    return undefined;
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId: value.commandId,
    sessionId: value.sessionId,
    type: value.type,
    issuedAt: value.issuedAt
  };
}

function isExactConnectedHandshake(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, CONNECTED_KEYS)
    && value.protocolVersion === PROTOCOL_VERSION
    && value.service === 'voivox'
    && value.status === 'connected';
}

function hasExactKeys(value: Record<string, unknown>, expected: Set<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNativeCommandType(value: unknown): value is NativeCommandType {
  return typeof value === 'string' && (COMMAND_TYPES as readonly string[]).includes(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
