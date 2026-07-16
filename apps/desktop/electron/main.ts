import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { createVoivoxLoopbackServer, JsonSessionStore, VoivoxService } from '@voivox/core';
import { BufferedAsrPipeline } from '../src/main/asr-pipeline.js';
import { DesktopRuntime } from '../src/main/desktop-runtime.js';
import { MacProcessTapHost } from '../src/main/mac-process-tap-host.js';
import { PythonQwenAsrEngine } from '../src/main/python-qwen-asr-engine.js';
import { resolvePythonCommand } from '../src/main/python-runtime.js';
import { readWavDuration } from '../src/main/wav-duration.js';
import { resolveBundledResource } from './resource-paths.js';

app.setName('VOIVOX');
let window: BrowserWindow | undefined;
let loopback: Awaited<ReturnType<typeof createVoivoxLoopbackServer>> | undefined;
let asrEngine: PythonQwenAsrEngine | undefined;
let macProcessTapHost: MacProcessTapHost | undefined;
let isShuttingDown = false;

async function bootstrap(): Promise<void> {
  const dataPath = app.getPath('userData');
  const runtime = new DesktopRuntime(
    new VoivoxService(() => new Date(), new JsonSessionStore(join(dataPath, 'sessions.json')))
  );
  const token = randomBytes(32).toString('base64url');
  const chromeBridgeToken = await getOrCreateToken(join(dataPath, 'chrome-bridge-token'));
  asrEngine = new PythonQwenAsrEngine({
    pythonCommand: resolvePythonCommand(dataPath, process.env.VOIVOX_PYTHON),
    workerPath: resolveBundledResource('voivox_asr_worker.py', {
      isPackaged: app.isPackaged,
      moduleUrl: import.meta.url,
      resourcesPath: process.resourcesPath
    })
  });
  const asrPipeline = new BufferedAsrPipeline(runtime.getService(), asrEngine, {
    onError: (error) => {
      console.error('VOIVOX local ASR error:', error.message);
      window?.webContents.send('voivox:asr-error', error.message);
    }
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
      console.error('VOIVOX process recording transcription error:', error);
      window?.webContents.send(
        'voivox:asr-error',
        error instanceof Error ? error.message : 'VOIVOX 无法转写这个 macOS 应用的录音。'
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
  loopback = await createVoivoxLoopbackServer({
    token,
    extensionToken: chromeBridgeToken,
    service: runtime.getService(),
    listMacProcesses: () => processTapHost.listProcesses(),
    onAudioChunk: (chunk) => asrPipeline.ingest(chunk),
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
  });
  await writeMcpConnectionFile(dataPath, loopback.baseUrl, token);
  registerIpc(runtime, {
    asrPipeline,
    chromeBridgeToken,
    onCaptureStopping: stopLocalCapture,
    processTapHost
  });
  createWindow();
}

function registerIpc(
  runtime: DesktopRuntime,
  options: {
    asrPipeline: BufferedAsrPipeline;
    chromeBridgeToken: string;
    onCaptureStopping: (sessionId: string) => Promise<void>;
    processTapHost: MacProcessTapHost;
  }
): void {
  ipcMain.handle('voivox:get-dashboard', () => runtime.getDashboard());
  ipcMain.handle('voivox:set-capture-mode', (_event, mode: unknown) => {
    if (mode !== 'fast' && mode !== 'normal') {
      throw new Error('VOIVOX capture mode must be fast or normal.');
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
      throw new Error('A VOIVOX session id is required.');
    }
    await options.onCaptureStopping(sessionId);
    runtime.stopCapture(sessionId);
  });
  ipcMain.handle('voivox:append-demo-segment', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') {
      throw new Error('A VOIVOX session id is required.');
    }
    runtime.appendDemoSegment(sessionId);
  });
  ipcMain.handle('voivox:get-chrome-bridge', () => {
    if (!loopback) {
      throw new Error('VOIVOX local bridge is not ready.');
    }
    return { baseUrl: loopback.baseUrl, token: options.chromeBridgeToken };
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    backgroundColor: '#f3f4f0',
    height: 760,
    minHeight: 620,
    minWidth: 760,
    show: false,
    title: 'VOIVOX',
    width: 1120,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: new URL('./preload.js', import.meta.url).pathname,
      sandbox: true
    }
  });

  window.once('ready-to-show', () => window?.show());
  void window.loadFile(new URL('../renderer/index.html', import.meta.url).pathname);
}

async function writeMcpConnectionFile(directory: string, baseUrl: string, token: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const connectionFile = join(directory, 'mcp-connection.json');
  await writeFile(
    connectionFile,
    `${JSON.stringify({ baseUrl, token }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  await chmod(connectionFile, 0o600);
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

app.whenReady().then(bootstrap).catch((error: unknown) => {
  console.error('VOIVOX could not start.', error);
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

async function shutdown(): Promise<void> {
  await macProcessTapHost?.discardAll();
  await loopback?.close();
  asrEngine?.close();
}
