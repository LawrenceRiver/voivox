#!/usr/bin/env node

import { homedir } from 'node:os';

import {
  createProductionBackendComponents,
  installHeadlessSignalHandlers,
  startVoiceVacBackend
} from '../src/main/backend-runtime.js';
import { removeMcpConnectionFileBestEffort } from '../src/main/mcp-connection.js';

try {
  const backend = await startVoiceVacBackend({
    environment: process.env,
    homeDirectory: homedir(),
    moduleUrl: import.meta.url,
    onCleanupError: () => {
      process.stderr.write('Voice VAC backend cleanup failed.\n');
    },
    onReady: (status) => {
      process.stdout.write(`${JSON.stringify(status)}\n`);
    }
  }, {
    createComponents: (context) => createProductionBackendComponents(context),
    removeMcpConnectionFile: (filePath) => removeMcpConnectionFileBestEffort(filePath)
  });
  installHeadlessSignalHandlers(backend, process, () => {
    process.stderr.write('Voice VAC backend shutdown failed.\n');
  });
} catch {
  process.stderr.write('Voice VAC backend failed to start.\n');
  process.exitCode = 1;
}
