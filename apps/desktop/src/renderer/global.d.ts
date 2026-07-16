import type { DesktopClient } from './app.js';

declare global {
  interface Window {
    voivox: DesktopClient;
  }
}

export {};
