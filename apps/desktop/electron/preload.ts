import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('voivox', {
  getCapabilities: () => ipcRenderer.invoke('voivox:get-capabilities'),
  getDashboard: () => ipcRenderer.invoke('voivox:get-dashboard'),
  getTunnelSessions: () => ipcRenderer.invoke('voivox:get-tunnel-sessions'),
  setCaptureMode: (mode: 'fast' | 'normal') => ipcRenderer.invoke('voivox:set-capture-mode', mode),
  startCapture: (source: unknown) => ipcRenderer.invoke('voivox:start-capture', source),
  stopCapture: (sessionId: string) => ipcRenderer.invoke('voivox:stop-capture', sessionId),
  appendDemoSegment: (sessionId: string) => ipcRenderer.invoke('voivox:append-demo-segment', sessionId),
  listMacProcesses: () => ipcRenderer.invoke('voivox:list-mac-processes'),
  onAsrError: (listener: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on('voivox:asr-error', handler);
    return () => ipcRenderer.removeListener('voivox:asr-error', handler);
  }
});
