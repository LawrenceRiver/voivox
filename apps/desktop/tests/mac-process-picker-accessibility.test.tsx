// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MacProcessPicker } from '../src/renderer/mac-process-picker.js';

afterEach(cleanup);

describe('macOS application picker keyboard behavior', () => {
  it('closes with Escape, traps Tab, and restores focus to the source trigger', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();

    const view = render(
      <MacProcessPicker
        loading={false}
        locale="en"
        onClose={onClose}
        onSelect={vi.fn()}
        processes={[{ bundleId: 'com.apple.Safari', name: 'Safari', pid: 101 }]}
      />
    );

    const closeButton = screen.getByRole('button', { name: 'Close' });
    const appButton = screen.getByRole('button', { name: /Safari/ });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(appButton);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
