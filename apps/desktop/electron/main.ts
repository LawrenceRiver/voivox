import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import {
  createVoivoxLoopbackServer,
  ExtensionCommandBroker,
  JsonSessionStore,
  VoivoxService,
  type VoivoxCapabilities
} from '@voivox/core';
import { BufferedAsrPipeline } from '../src/main/asr-pipeline.js';
import { ActiveVideoCoordinator } from '../src/main/active-video-coordinator.js';
import { DesktopRuntime } from '../src/main/desktop-runtime.js';
import { ExtensionCaptureController } from '../src/main/extension-capture-controller.js';
import { startLocalAsrCapabilityProbe } from '../src/main/local-asr-capability.js';
import { startWithExtensionDiscovery } from '../src/main/local-discovery.js';
import { MacProcessTapHost } from '../src/main/mac-process-tap-host.js';
import { removeMcpConnectionFileBestEffort } from '../src/main/mcp-connection.js';
import {
  createExtensionConnectionPublisher,
  installNativeMessagingHost,
  type ExtensionConnectionPublisher
} from '../src/main/native-messaging.js';
import { PythonQwenAsrEngine } from '../src/main/python-qwen-asr-engine.js';
import { resolvePythonCommand, resolveQwenModelPath } from '../src/main/python-runtime.js';
import { enforceSingleInstance } from '../src/main/single-instance.js';
import { readWavDuration } from '../src/main/wav-duration.js';
import { resolveBundledResource, resolveElectronEntryPoints } from './resource-paths.js';

app.setName('Voice Vac');
let window: BrowserWindow | undefined;
let loopback: Awaited<ReturnType<typeof createVoivoxLoopbackServer>> | undefined;
let asrEngine: PythonQwenAsrEngine | undefined;
let macProcessTapHost: MacProcessTapHost | undefined;
let extensionConnectionPublisher: ExtensionConnectionPublisher | undefined;
let mcpConnectionFilePath: string | undefined;
let isShuttingDown = false;
const isPrimaryInstance = enforceSingleInstance(app, () => window);

async function bootstrap(): Promise<void> {
  const dataPath = app.getPath('userData');
  const runtime = new DesktopRuntime(
    new VoivoxService(() => new Date(), new JsonSessionStore(join(dataPath, 'sessions.json')))
  );
  const token = randomBytes(32).toString('base64url');
  const chromeBridgeToken = await getOrCreateToken(join(dataPath, 'chrome-bridge-token'));
  let nativeMessagingReady = false;
  const pythonCommand = resolvePythonCommand(dataPath, process.env.VOIVOX_PYTHON);
  const modelPath = resolveQwenModelPath(dataPath, process.env.VOICE_VAC_QWEN_MODEL_PATH);
  asrEngine = new PythonQwenAsrEngine({
    modelPath,
    pythonCommand,
    workerPath: resolveBundledResource('voivox_asr_worker.py', {
      isPackaged: app.isPackaged,
      moduleUrl: import.meta.url,
      resourcesPath: process.resourcesPath
    })
  });
  const localAsrProbe = startLocalAsrCapabilityProbe(asrEngine);
  const asrPipeline = new BufferedAsrPipeline(runtime.getService(), asrEngine, {
    onError: (error) => {
      console.error('Voice Vac local ASR error:', error.message);
      window?.webContents.send('voivox:asr-error', error.message);
    }
  });
  const extensionCaptureController = new ExtensionCaptureController({
    pipeline: asrPipeline,
    service: runtime.getService(),
    tunnelSessions: runtime.getTunnelSessions()
  });
  const extensionCommands = new ExtensionCommandBroker();
  const activeVideoCoordinator = new ActiveVideoCoordinator({
    extensionCaptureController,
    extensionCommands,
    service: runtime.getService(),
    tunnelSessions: runtime.getTunnelSessions()
  });
  const processTapHost = new MacProcessTapHost(
    resolveBundledResource('voivox-host', {
      isPackaged: app.isPackaged,
      moduleUrl: import.meta.url,
      resourcesPath: process.resourcesPath
    })
  );
  macProcessTapHost = processTapHost;
  const transcribeProcessRecording = async (sessionId: string, audioPath: string): Promise<void> => {
    try {
      const [result, durationMs] = await Promise.all([
        asrEngine!.transcribeFile(audioPath),
        readWavDuration(audioPath)
      ]);
      if (result.text.trim()) {
        runtime.getService().appendRawSegment(sessionId, {
          startMs: 0,
          endMs: durationMs ?? 0,
          text: result.text.trim()
        });
      }
    } catch (error) {
      console.error('Voice Vac process recording transcription error:', error);
      window?.webContents.send(
        'voivox:asr-error',
        error instanceof Error ? error.message : 'Voice Vac 无法转写这个 macOS 应用的录音。'
      );
    } finally {
      await rm(dirname(audioPath), { force: true, recursive: true });
    }
  };
  const stopLocalCapture = async (sessionId: string): Promise<void> => {
    await asrPipeline.finish(sessionId);
    const recordingPath = await processTapHost.stop(sessionId);
    if (recordingPath) {
      await transcribeProcessRecording(sessionId, recordingPath);
    }
  };
  const started = await startWithExtensionDiscovery(({ port }) =>
    createVoivoxLoopbackServer({
      token,
      port,
      extensionToken: chromeBridgeToken,
      capabilities: () => ({
        extensionDiscovery: nativeMessagingReady,
        localAsr: localAsrProbe.getStatus()
      }),
      extensionCaptureController,
      extensionCommands,
      onActiveVideoTranscription: (request) => activeVideoCoordinator.transcribe(request),
      service: runtime.getService(),
      tunnelSessions: runtime.getTunnelSessions(),
      listMacProcesses: () => processTapHost.listProcesses(),
      onCaptureStarted: async (session) => {
        if (session.source.kind !== 'macos-process') {
          return;
        }
        if (!session.source.processId) {
          throw new Error('Choose a macOS app process before starting capture.');
        }
        await processTapHost.start(session.id, session.source.processId);
      },
      onCaptureStopping: stopLocalCapture
    })
  );
  loopback = started.server;
  const getCapabilities = (): VoivoxCapabilities => ({
    extensionDiscovery: nativeMessagingReady,
    localAsr: localAsrProbe.getStatus()
  });
  mcpConnectionFilePath = await writeMcpConnectionFile(dataPath, loopback.baseUrl, token);
  const nativeMessagingHostPath = resolveBundledResource('voivox-native-host', {
    isPackaged: app.isPackaged,
    moduleUrl: import.meta.url,
    resourcesPath: process.resourcesPath
  });
  const nativeMessagingInstallation = await installNativeMessagingHost({
    executablePath: nativeMessagingHostPath,
    homeDirectory: app.getPath('home')
  });
  nativeMessagingReady = nativeMessagingInstallation.installed.length > 0;
  for (const failure of nativeMessagingInstallation.failed) {
    console.warn(`Voice Vac could not install a browser native host manifest at ${failure.path}: ${failure.reason}`);
  }
  extensionConnectionPublisher = createExtensionConnectionPublisher({
    baseUrl: loopback.baseUrl,
    dataPath,
    extensionToken: chromeBridgeToken
  });
  await extensionConnectionPublisher.publish(localAsrProbe.getStatus());
  void localAsrProbe.completion
    .then((localAsr) => extensionConnectionPublisher?.publish(localAsr))
    .catch((error: unknown) => {
      console.error('Voice Vac could not update extension discovery:', error);
    });
  registerIpc(runtime, {
    asrPipeline,
    getCapabilities,
    onCaptureStopping: stopLocalCapture,
    processTapHost
  });
  createWindow();
}

function registerIpc(
  runtime: DesktopRuntime,
  options: {
    asrPipeline: BufferedAsrPipeline;
    getCapabilities: () => VoivoxCapabilities;
    onCaptureStopping: (sessionId: string) => Promise<void>;
    processTapHost: MacProcessTapHost;
  }
): void {
  ipcMain.handle('voivox:get-capabilities', () => options.getCapabilities());
  ipcMain.handle('voivox:get-dashboard', () => runtime.getDashboard());
  ipcMain.handle('voivox:get-tunnel-sessions', () => runtime.getTunnelSessions().list());
  ipcMain.handle('voivox:set-capture-mode', (_event, mode: unknown) => {
    if (mode !== 'fast' && mode !== 'normal') {
      throw new Error('Voice Vac capture mode must be fast or normal.');
    }
    options.asrPipeline.setMinimumWindowMs(mode === 'fast' ? 4_000 : 8_000);
  });
  ipcMain.handle('voivox:list-mac-processes', () => options.processTapHost.listProcesses());
  ipcMain.handle('voivox:start-capture', async (_event, source: unknown) => {
    const captureSource = assertSource(source);
    const session = runtime.startCapture(captureSource);
    try {
      if (captureSource.kind === 'macos-process') {
        if (!captureSource.processId) {
          throw new Error('Choose a macOS app before starting its silent capture.');
        }
        await options.processTapHost.start(session.id, captureSource.processId);
      }
      return session;
    } catch (error) {
      runtime.stopCapture(session.id);
      throw error;
    }
  });
  ipcMain.handle('voivox:stop-capture', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      throw new Error('A Voice Vac session id is required.');
    }
    await options.onCaptureStopping(sessionId);
    runtime.stopCapture(sessionId);
  });
  ipcMain.handle('voivox:append-demo-segment', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      throw new Error('A Voice Vac session id is required.');
    }
    runtime.appendDemoSegment(sessionId);
  });
}

function createWindow(): void {
  const entryPoints = resolveElectronEntryPoints(import.meta.url);
  window = new BrowserWindow({
    alwaysOnTop: true,
    backgroundColor: '#00ffffff',
    height: 210,
    minHeight: 185,
    minWidth: 520,
    show: false,
    title: 'Voice Vac',
    titleBarStyle: 'hiddenInset',
    transparent: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    width: 640,
    resizable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: entryPoints.preload,
      sandbox: true
    }
  });

  window.once('ready-to-show', () => window?.show());
  void window.loadFile(entryPoints.renderer);
}

async function writeMcpConnectionFile(directory: string, baseUrl: string, token: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const connectionFile = join(directory, 'mcp-connection.json');
  await writeFile(
    connectionFile,
    `${JSON.stringify({ baseUrl, token }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  await chmod(connectionFile, 0o600);
  return connectionFile;
}

async function getOrCreateToken(filePath: string): Promise<string> {
  try {
    const token = (await readFile(filePath, 'utf8')).trim();
    if (token.length >= 32) {
      await chmod(filePath, 0o600);
      return token;
    }
  } catch {
    // First launch creates a token below.
  }

  const token = randomBytes(32).toString('base64url');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600);
  return token;
}

function assertSource(value: unknown): { kind: 'chrome-tab' | 'macos-process' | 'microphone'; label: string; processId?: number } {
  if (!value || typeof value !== 'object') {
    throw new Error('A capture source is required.');
  }
  const source = value as { kind?: unknown; label?: unknown; processId?: unknown };
  if (
    (source.kind !== 'chrome-tab' && source.kind !== 'macos-process' && source.kind !== 'microphone') ||
    typeof source.label !== 'string' ||
    source.label.length === 0 ||
    (source.processId !== undefined && (typeof source.processId !== 'number' || !Number.isInteger(source.processId) || source.processId <= 0))
  ) {
    throw new Error('The capture source is invalid.');
  }
  return { kind: source.kind, label: source.label, processId: source.processId as number | undefined };
}

if (isPrimaryInstance) {
  app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error('Voice Vac could not start.', error);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('before-quit', (event) => {
    if (isShuttingDown) {
      return;
    }
    event.preventDefault();
    isShuttingDown = true;
    void shutdown().finally(() => app.exit());
  });
}

function reportShutdownError(error: unknown): void {
  console.error('Voice Vac shutdown cleanup failed:', error);
}

async function shutdown(): Promise<void> {
  await removeMcpConnectionFileBestEffort(mcpConnectionFilePath).catch(reportShutdownError);
  mcpConnectionFilePath = undefined;
  await extensionConnectionPublisher?.invalidate().catch(reportShutdownError);
  await asrEngine?.close().catch(reportShutdownError);
  await macProcessTapHost?.discardAll().catch(reportShutdownError);
  await loopback?.close().catch(reportShutdownError);
}
