import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

type ReadyStatus = {
  capabilities: { extensionDiscovery: boolean; localAsr: 'checking' | 'ready' | 'missing' };
  service: 'voivox';
  status: 'ready';
};

type BackendComponents = {
  asrEngine: { close: () => Promise<void> };
  extensionConnectionPublisher: { invalidate: () => Promise<void> };
  loopback: { close: () => Promise<void> };
  mcpConnectionFilePath: string;
  readyStatus: ReadyStatus;
};

type BackendRuntimeModule = {
  resolveVoiceVacDataPath?: (homeDirectory: string) => string;
  resolveVoiceVacResourceDirectory?: (options: {
    environment: NodeJS.ProcessEnv;
    moduleUrl: string;
  }) => string;
  startVoiceVacBackend?: (
    options: {
      environment: NodeJS.ProcessEnv;
      homeDirectory: string;
      moduleUrl: string;
      onCleanupError?: (error: unknown) => void;
      onReady?: (status: ReadyStatus) => void;
    },
    dependencies: {
      createComponents: (context: {
        dataPath: string;
        environment: NodeJS.ProcessEnv;
        homeDirectory: string;
        resourceDirectory: string;
      }) => Promise<BackendComponents>;
      removeMcpConnectionFile: (filePath: string | undefined) => Promise<void>;
    }
  ) => Promise<{ close: () => Promise<void>; status: ReadyStatus }>;
  createProductionBackendComponents?: (
    context: {
      dataPath: string;
      environment: NodeJS.ProcessEnv;
      homeDirectory: string;
      resourceDirectory: string;
    },
    adapters: Record<string, unknown>
  ) => Promise<BackendComponents>;
  installHeadlessSignalHandlers?: (
    backend: { close: () => Promise<void> },
    processLike: EventEmitter & { exitCode?: number },
    onError?: (error: unknown) => void
  ) => () => void;
};

async function loadBackendRuntime(): Promise<BackendRuntimeModule> {
  const moduleUrl = new URL('../src/main/backend-runtime.ts', import.meta.url).href;
  return import(/* @vite-ignore */ moduleUrl).catch(() => ({}));
}

describe('headless backend paths', () => {
  it('uses the Voice Vac Application Support directory expected by MCP and native messaging', async () => {
    const runtime = await loadBackendRuntime();

    expect(runtime.resolveVoiceVacDataPath).toBeTypeOf('function');
    expect(runtime.resolveVoiceVacDataPath?.('/Users/tester')).toBe(
      join('/Users/tester', 'Library', 'Application Support', 'Voice Vac')
    );
  });

  it('uses VOICE_VAC_RESOURCE_DIR before resolving resources beside the bundled headless entry', async () => {
    const runtime = await loadBackendRuntime();

    expect(runtime.resolveVoiceVacResourceDirectory).toBeTypeOf('function');
    expect(runtime.resolveVoiceVacResourceDirectory?.({
      environment: { VOICE_VAC_RESOURCE_DIR: '/Applications/Voice VAC.app/Contents/Resources/voivox' },
      moduleUrl: 'file:///ignored/dist/headless/voice-vac-backend.mjs'
    })).toBe('/Applications/Voice VAC.app/Contents/Resources/voivox');
    expect(runtime.resolveVoiceVacResourceDirectory?.({
      environment: {},
      moduleUrl: 'file:///workspace/apps/desktop/dist/headless/voice-vac-backend.mjs'
    })).toBe('/workspace/apps/desktop/dist/resources');
  });
});

describe('headless backend lifecycle', () => {
  it('publishes only a keyless ready status after its injected components start', async () => {
    const runtime = await loadBackendRuntime();
    expect(runtime.startVoiceVacBackend).toBeTypeOf('function');
    const onReady = vi.fn();
    const components = createComponents();
    const create = vi.fn(async () => components.value);

    const backend = await runtime.startVoiceVacBackend?.({
      environment: { VOICE_VAC_RESOURCE_DIR: '/Applications/Voice VAC.app/Contents/Resources/voivox' },
      homeDirectory: '/Users/tester',
      moduleUrl: 'file:///workspace/apps/desktop/dist/headless/voice-vac-backend.mjs',
      onReady
    }, {
      createComponents: create,
      removeMcpConnectionFile: async () => undefined
    });

    expect(create).toHaveBeenCalledWith({
      dataPath: '/Users/tester/Library/Application Support/Voice Vac',
      environment: { VOICE_VAC_RESOURCE_DIR: '/Applications/Voice VAC.app/Contents/Resources/voivox' },
      homeDirectory: '/Users/tester',
      resourceDirectory: '/Applications/Voice VAC.app/Contents/Resources/voivox'
    });
    expect(onReady).toHaveBeenCalledExactlyOnceWith(components.value.readyStatus);
    expect(JSON.stringify(onReady.mock.calls)).not.toMatch(/primary-token|extension-token|bearer/iu);
    expect(backend).toEqual({ close: expect.any(Function), status: components.value.readyStatus });
  });

  it('closes connection files, ASR, and loopback once in safe order even when cleanup rejects', async () => {
    const runtime = await loadBackendRuntime();
    expect(runtime.startVoiceVacBackend).toBeTypeOf('function');
    const calls: string[] = [];
    const cleanupErrors: unknown[] = [];
    const components = createComponents(calls);
    components.asrEngine.mockImplementationOnce(async () => {
      calls.push('asr');
      throw new Error('ASR close failed');
    });

    const backend = await runtime.startVoiceVacBackend?.({
      environment: {},
      homeDirectory: '/Users/tester',
      moduleUrl: 'file:///workspace/apps/desktop/dist/headless/voice-vac-backend.mjs',
      onCleanupError: (error) => cleanupErrors.push(error)
    }, {
      createComponents: async () => components.value,
      removeMcpConnectionFile: async () => {
        calls.push('mcp');
        throw new Error('MCP cleanup failed');
      }
    });

    await Promise.all([backend!.close(), backend!.close()]);

    expect(calls).toEqual(['mcp', 'extension', 'asr', 'loopback']);
    expect(cleanupErrors).toHaveLength(2);
    expect(components.extension).toHaveBeenCalledOnce();
    expect(components.asrEngine).toHaveBeenCalledOnce();
    expect(components.loopback).toHaveBeenCalledOnce();
  });

  it('cleans every started component when the ready observer rejects startup', async () => {
    const runtime = await loadBackendRuntime();
    expect(runtime.startVoiceVacBackend).toBeTypeOf('function');
    const calls: string[] = [];
    const components = createComponents(calls);
    const failure = new Error('ready output unavailable');

    await expect(runtime.startVoiceVacBackend?.({
      environment: {},
      homeDirectory: '/Users/tester',
      moduleUrl: 'file:///workspace/apps/desktop/dist/headless/voice-vac-backend.mjs',
      onReady: () => { throw failure; }
    }, {
      createComponents: async () => components.value,
      removeMcpConnectionFile: async () => { calls.push('mcp'); }
    })).rejects.toBe(failure);

    expect(calls).toEqual(['mcp', 'extension', 'asr', 'loopback']);
  });

  it('composes the persistent service, Qwen pipeline, extension controller, server, and connection files', async () => {
    const runtime = await loadBackendRuntime();
    expect(runtime.createProductionBackendComponents).toBeTypeOf('function');
    const root = await mkdtemp(join(tmpdir(), 'voice-vac-headless-'));
    const dataPath = join(root, 'Library', 'Application Support', 'Voice Vac');
    const loopbackClose = vi.fn(async () => undefined);
    const engineClose = vi.fn(async () => undefined);
    const engine = {
      close: engineClose,
      getStatus: () => 'ready' as const,
      start: async () => undefined,
      transcribe: async () => ({ text: '' })
    };
    let serverOptions: Record<string, unknown> | undefined;
    const createLoopbackServer = vi.fn(async (options: Record<string, unknown>) => {
      serverOptions = options;
      return { baseUrl: 'http://127.0.0.1:43817', close: loopbackClose };
    });
    const createAsrEngine = vi.fn(() => engine);
    const installNativeMessagingHost = vi.fn(async () => ({ failed: [], installed: ['manifest.json'] }));
    try {
      const components = await runtime.createProductionBackendComponents?.({
        dataPath,
        environment: { VOIVOX_PYTHON: '/custom/python' },
        homeDirectory: root,
        resourceDirectory: '/Applications/Voice VAC.app/Contents/Resources/voivox'
      }, {
        createAsrEngine,
        createLoopbackServer,
        createPrimaryToken: () => 'primary-token',
        getOrCreateExtensionToken: async () => 'extension-token',
        installNativeMessagingHost,
        startAsrProbe: () => ({
          completion: Promise.resolve('ready'),
          getStatus: () => 'checking'
        })
      });

      expect(createAsrEngine).toHaveBeenCalledWith({
        modelPath: undefined,
        pythonCommand: '/custom/python',
        workerPath: '/Applications/Voice VAC.app/Contents/Resources/voivox/voivox_asr_worker.py'
      });
      expect(installNativeMessagingHost).toHaveBeenCalledWith({
        executablePath: '/Applications/Voice VAC.app/Contents/Resources/voivox/voivox-native-host',
        homeDirectory: root
      });
      expect(createLoopbackServer).toHaveBeenCalledOnce();
      expect(serverOptions).toMatchObject({
        extensionToken: 'extension-token',
        port: 43817,
        token: 'primary-token'
      });
      expect(serverOptions?.service).toBeDefined();
      expect(serverOptions?.tunnelSessions).toBeDefined();
      expect(serverOptions?.extensionCaptureController).toBeDefined();
      expect((serverOptions?.capabilities as () => unknown)()).toEqual({
        extensionDiscovery: true,
        localAsr: 'checking'
      });
      expect(JSON.parse(await readFile(join(dataPath, 'mcp-connection.json'), 'utf8'))).toEqual({
        baseUrl: 'http://127.0.0.1:43817',
        token: 'primary-token'
      });
      await vi.waitFor(async () => {
        expect(JSON.parse(await readFile(join(dataPath, 'extension-connection.json'), 'utf8')))
          .toMatchObject({ capabilities: { localAsr: 'ready' }, token: 'extension-token' });
      });
      expect(components?.readyStatus).toEqual({
        capabilities: { extensionDiscovery: true, localAsr: 'checking' },
        service: 'voivox',
        status: 'ready'
      });

      await components?.extensionConnectionPublisher.invalidate();
      await components?.asrEngine.close();
      await components?.loopback.close();
      expect(engineClose).toHaveBeenCalledOnce();
      expect(loopbackClose).toHaveBeenCalledOnce();
      await expect(access(join(dataPath, 'extension-connection.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('handles SIGTERM and SIGINT through one idempotent asynchronous shutdown', async () => {
    const runtime = await loadBackendRuntime();
    expect(runtime.installHeadlessSignalHandlers).toBeTypeOf('function');
    const processLike = new EventEmitter() as EventEmitter & { exitCode?: number };
    const close = vi.fn(async () => undefined);
    const detach = runtime.installHeadlessSignalHandlers?.({ close }, processLike);

    processLike.emit('SIGTERM');
    processLike.emit('SIGINT');
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(processLike.exitCode).toBe(0));
    expect(processLike.listenerCount('SIGTERM')).toBe(0);
    expect(processLike.listenerCount('SIGINT')).toBe(0);

    detach?.();
    processLike.emit('SIGTERM');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes a started Qwen engine when startup fails before the loopback server exists', async () => {
    const runtime = await loadBackendRuntime();
    expect(runtime.createProductionBackendComponents).toBeTypeOf('function');
    const engineClose = vi.fn(async () => undefined);
    const engine = {
      close: engineClose,
      getStatus: () => 'idle' as const,
      start: async () => undefined,
      transcribe: async () => ({ text: '' })
    };
    const failure = new Error('read-only Application Support');

    await expect(runtime.createProductionBackendComponents?.({
      dataPath: '/read-only/Voice Vac',
      environment: {},
      homeDirectory: '/Users/tester',
      resourceDirectory: '/bundle/resources'
    }, {
      createAsrEngine: () => engine,
      createLoopbackServer: vi.fn(),
      createPrimaryToken: () => 'primary-token',
      getOrCreateExtensionToken: async () => { throw failure; },
      installNativeMessagingHost: vi.fn(),
      startAsrProbe: () => ({
        completion: new Promise(() => undefined),
        getStatus: () => 'checking'
      })
    })).rejects.toBe(failure);
    expect(engineClose).toHaveBeenCalledOnce();
  });
});

function createComponents(calls: string[] = []) {
  const extension = vi.fn(async () => { calls.push('extension'); });
  const asrEngine = vi.fn(async () => { calls.push('asr'); });
  const loopback = vi.fn(async () => { calls.push('loopback'); });
  return {
    asrEngine,
    extension,
    loopback,
    value: {
      asrEngine: { close: asrEngine },
      extensionConnectionPublisher: { invalidate: extension },
      loopback: { close: loopback },
      mcpConnectionFilePath: '/Users/tester/Library/Application Support/Voice Vac/mcp-connection.json',
      readyStatus: {
        capabilities: { extensionDiscovery: true, localAsr: 'checking' },
        service: 'voivox',
        status: 'ready'
      }
    } satisfies BackendComponents
  };
}
