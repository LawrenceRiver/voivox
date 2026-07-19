import { describe, expect, it, vi } from 'vitest';

import { enforceSingleInstance } from '../src/main/single-instance.js';

describe('desktop single-instance lifecycle', () => {
  it('quits before startup when another Voice Vac instance owns the lock', () => {
    const quit = vi.fn();
    const on = vi.fn();

    const isPrimary = enforceSingleInstance(
      { on, quit, requestSingleInstanceLock: () => false },
      () => undefined
    );

    expect(isPrimary).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(on).not.toHaveBeenCalled();
  });

  it('restores and focuses the existing window when a second instance starts', () => {
    let secondInstance: (() => void) | undefined;
    const window = {
      focus: vi.fn(),
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn()
    };

    const isPrimary = enforceSingleInstance(
      {
        on: (event, listener) => {
          expect(event).toBe('second-instance');
          secondInstance = listener;
        },
        quit: vi.fn(),
        requestSingleInstanceLock: () => true
      },
      () => window
    );
    secondInstance?.();

    expect(isPrimary).toBe(true);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});
