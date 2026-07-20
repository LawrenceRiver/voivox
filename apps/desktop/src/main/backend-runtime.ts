import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createVoivoxLoopbackServer,
  CrossWindowSessionStore,
  ExtensionCommandBroker,
  JsonSessionStore,
  VoivoxService,
  type LocalAsrStatus
} from '@voivox/core';
import { ActiveVideoCoordinator } from './active-video-coordinator.js';
import { BufferedAsrPipeline, type LocalAsrEngine } from './asr-pipeline.js';
import { ExtensionCaptureController } from './extension-capture-controller.js';
import {
  startLocalAsrCapabilityProbe,
  type LocalAsrCapabilityProbe,
  type LocalAsrReadinessSource
} from './local-asr-capability.js';
import { startWithExtensionDiscovery } from './local-discovery.js';
import {
  removeMcpConnectionFileBestEffort,
  writeMcpConnectionFile
} from './mcp-connection.js';
import {
  createExtensionConnectionPublisher,
  installNativeMessagingHost,
  type ExtensionConnectionPublisher,
  type NativeMessagingHostInstallation
} from './native-messaging.js';
import {
  PythonQwenAsrEngine,
  type PythonQwenAsrEngineOptions
} from './python-qwen-asr-engine.js';
import { resolvePythonCommand, resolveQwenModelPath } from './python-runtime.js';

export type HeadlessReadyStatus = Readonly<{
  capabilities: Readonly<{
    extensionDiscovery: boolean;
    localAsr: LocalAsrStatus;
  }>;
  service: 'voivox';
  status: 'ready';
}>;

export type HeadlessBackendComponents = Readonly<{
  asrEngine: { close: () => Promise<void> };
  extensionConnectionPublisher: { invalidate: () => Promise<void> };
  loopback: { close: () => Promise<void> };
  mcpConnectionFilePath: string;
  readyStatus: HeadlessReadyStatus;
}>;

export type HeadlessBackendContext = Readonly<{
  dataPath: string;
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  resourceDirectory: string;
}>;

export type HeadlessBackendDependencies = Readonly<{
  createComponents: (context: HeadlessBackendContext) => Promise<HeadlessBackendComponents>;
  removeMcpConnectionFile: (filePath: string | undefined) => Promise<void>;
}>;

export type HeadlessBackend = Readonly<{
  close: () => Promise<void>;
  status: HeadlessReadyStatus;
}>;

export type HeadlessSignalProcess = {
  exitCode?: string | number | null;
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

type HeadlessAsrEngine = LocalAsrEngine & LocalAsrReadinessSource & {
  close: () => Promise<void>;
};

type LoopbackOptions = Parameters<typeof createVoivoxLoopbackServer>[0];
type LoopbackServer = Awaited<ReturnType<typeof createVoivoxLoopbackServer>>;

export type ProductionBackendAdapters = Readonly<{
  createAsrEngine: (options: PythonQwenAsrEngineOptions) => HeadlessAsrEngine;
  createLoopbackServer: (options: LoopbackOptions) => Promise<LoopbackServer>;
  createPrimaryToken: () => string;
  getOrCreateExtensionToken: (filePath: string) => Promise<string>;
  installNativeMessagingHost: (options: {
    executablePath: string;
    homeDirectory: string;
  }) => Promise<NativeMessagingHostInstallation>;
  startAsrProbe: (engine: HeadlessAsrEngine) => LocalAsrCapabilityProbe;
}>;

export const productionBackendAdapters: ProductionBackendAdapters = Object.freeze({
  createAsrEngine: (options) => new PythonQwenAsrEngine(options),
  createLoopbackServer: (options) => createVoivoxLoopbackServer(options),
  createPrimaryToken: () => randomBytes(32).toString('base64url'),
  getOrCreateExtensionToken,
  installNativeMessagingHost: (options) => installNativeMessagingHost(options),
  startAsrProbe: (engine) => startLocalAsrCapabilityProbe(engine)
});

export function resolveVoiceVacDataPath(homeDirectory: string): string {
  return join(homeDirectory, 'Library', 'Application Support', 'Voice Vac');
}

export function resolveVoiceVacResourceDirectory(options: {
  environment: NodeJS.ProcessEnv;
  moduleUrl: string;
}): string {
  const override = options.environment.VOICE_VAC_RESOURCE_DIR;
  return override?.trim()
    ? resolve(override)
    : fileURLToPath(new URL('../resources', options.moduleUrl));
}

export async function startVoiceVacBackend(
  options: {
    environment: NodeJS.ProcessEnv;
    homeDirectory: string;
    moduleUrl: string;
    onCleanupError?: (error: unknown) => void;
    onReady?: (status: HeadlessReadyStatus) => void;
  },
  dependencies: HeadlessBackendDependencies
): Promise<HeadlessBackend> {
  const components = await dependencies.createComponents({
    dataPath: resolveVoiceVacDataPath(options.homeDirectory),
    environment: options.environment,
    homeDirectory: options.homeDirectory,
    resourceDirectory: resolveVoiceVacResourceDirectory(options)
  });
  const status: HeadlessReadyStatus = Object.freeze({
    capabilities: Object.freeze({
      extensionDiscovery: components.readyStatus.capabilities.extensionDiscovery,
      localAsr: components.readyStatus.capabilities.localAsr
    }),
    service: 'voivox',
    status: 'ready'
  });
  try {
    options.onReady?.(status);
  } catch (error) {
    await closeComponents(components, dependencies, options.onCleanupError);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= closeComponents(components, dependencies, options.onCleanupError);
    return closePromise;
  };
  return Object.freeze({ close, status });
}

export async function createProductionBackendComponents(
  context: HeadlessBackendContext,
  adapters: ProductionBackendAdapters = productionBackendAdapters
): Promise<HeadlessBackendComponents> {
  const service = new VoivoxService(
    () => new Date(),
    new JsonSessionStore(join(context.dataPath, 'sessions.json'))
  );
  const tunnelSessions = new CrossWindowSessionStore();
  const asrEngine = adapters.createAsrEngine({
    modelPath: resolveQwenModelPath(
      context.dataPath,
      context.environment.VOICE_VAC_QWEN_MODEL_PATH
    ),
    pythonCommand: resolvePythonCommand(
      context.dataPath,
      context.environment.VOIVOX_PYTHON
    ),
    workerPath: join(context.resourceDirectory, 'voivox_asr_worker.py')
  });
  let loopback: LoopbackServer | undefined;
  let extensionConnectionPublisher: ExtensionConnectionPublisher | undefined;
  let mcpConnectionFilePath: string | undefined;

  try {
    const asrProbe = adapters.startAsrProbe(asrEngine);
    const pipeline = new BufferedAsrPipeline(service, asrEngine);
    const extensionCaptureController = new ExtensionCaptureController({
      pipeline,
      service,
      tunnelSessions
    });
    const extensionCommands = new ExtensionCommandBroker();
    const activeVideoCoordinator = new ActiveVideoCoordinator({
      extensionCaptureController,
      extensionCommands,
      service,
      tunnelSessions
    });
    const primaryToken = adapters.createPrimaryToken();
    const extensionToken = await adapters.getOrCreateExtensionToken(
      join(context.dataPath, 'chrome-bridge-token')
    );
    const nativeMessagingInstallation = await adapters.installNativeMessagingHost({
      executablePath: join(context.resourceDirectory, 'voivox-native-host'),
      homeDirectory: context.homeDirectory
    });
    const nativeMessagingReady = nativeMessagingInstallation.installed.length > 0;
    const started = await startWithExtensionDiscovery(({ port }) =>
      adapters.createLoopbackServer({
        capabilities: () => ({
          extensionDiscovery: nativeMessagingReady,
          localAsr: asrProbe.getStatus()
        }),
        extensionCaptureController,
        extensionToken,
        extensionCommands,
        onActiveVideoTranscription: (request) => activeVideoCoordinator.transcribe(request),
        port,
        service,
        token: primaryToken,
        tunnelSessions
      })
    );
    loopback = started.server;
    mcpConnectionFilePath = await writeMcpConnectionFile(
      context.dataPath,
      loopback.baseUrl,
      primaryToken
    );
    extensionConnectionPublisher = createExtensionConnectionPublisher({
      baseUrl: loopback.baseUrl,
      dataPath: context.dataPath,
      extensionToken
    });
    await extensionConnectionPublisher.publish(asrProbe.getStatus());
    const publisher = extensionConnectionPublisher;
    void asrProbe.completion
      .then((localAsr) => publisher.publish(localAsr))
      .catch(() => undefined);

    return {
      asrEngine,
      extensionConnectionPublisher,
      loopback,
      mcpConnectionFilePath,
      readyStatus: {
        capabilities: {
          extensionDiscovery: nativeMessagingReady,
          localAsr: asrProbe.getStatus()
        },
        service: 'voivox',
        status: 'ready'
      }
    };
  } catch (error) {
    await removeMcpConnectionFileBestEffort(mcpConnectionFilePath);
    await extensionConnectionPublisher?.invalidate().catch(() => undefined);
    await asrEngine.close().catch(() => undefined);
    await loopback?.close().catch(() => undefined);
    throw error;
  }
}

export function installHeadlessSignalHandlers(
  backend: Pick<HeadlessBackend, 'close'>,
  processLike: HeadlessSignalProcess = process,
  onError?: (error: unknown) => void
): () => void {
  let closing = false;
  const detach = (): void => {
    processLike.removeListener('SIGTERM', shutdown);
    processLike.removeListener('SIGINT', shutdown);
  };
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    detach();
    void backend.close().then(
      () => { processLike.exitCode = 0; },
      (error: unknown) => {
        onError?.(error);
        processLike.exitCode = 1;
      }
    );
  };
  processLike.once('SIGTERM', shutdown);
  processLike.once('SIGINT', shutdown);
  return detach;
}

async function closeComponents(
  components: HeadlessBackendComponents,
  dependencies: HeadlessBackendDependencies,
  onCleanupError: ((error: unknown) => void) | undefined
): Promise<void> {
  await cleanup(() => dependencies.removeMcpConnectionFile(components.mcpConnectionFilePath), onCleanupError);
  await cleanup(() => components.extensionConnectionPublisher.invalidate(), onCleanupError);
  await cleanup(() => components.asrEngine.close(), onCleanupError);
  await cleanup(() => components.loopback.close(), onCleanupError);
}

async function cleanup(
  operation: () => Promise<void>,
  onError: ((error: unknown) => void) | undefined
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    onError?.(error);
  }
}

async function getOrCreateExtensionToken(filePath: string): Promise<string> {
  try {
    const token = (await readFile(filePath, 'utf8')).trim();
    if (token.length >= 32 && !/\s/u.test(token)) {
      await chmod(filePath, 0o600);
      return token;
    }
  } catch {
    // First launch creates the restricted extension token below.
  }

  const token = randomBytes(32).toString('base64url');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600);
  return token;
}
