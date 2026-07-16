export type SingleInstanceWindow = {
  focus: () => void;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
};

export type SingleInstanceApp = {
  on: (event: 'second-instance', listener: () => void) => unknown;
  quit: () => void;
  requestSingleInstanceLock: () => boolean;
};

export function enforceSingleInstance(
  app: SingleInstanceApp,
  getWindow: () => SingleInstanceWindow | undefined
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    const window = getWindow();
    if (!window) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  });
  return true;
}
