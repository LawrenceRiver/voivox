import { describe, expect, it } from 'vitest';

import { resolvePythonCommand } from '../src/main/python-runtime.js';

describe('local ASR Python runtime selection', () => {
  it('prefers an explicit override for advanced installations', () => {
    expect(resolvePythonCommand('/Library/Application Support/Voice Vac', '/custom/python', () => true)).toBe('/custom/python');
  });

  it('uses the Voice Vac-managed virtual environment after the installer runs', () => {
    expect(
      resolvePythonCommand('/Library/Application Support/Voice Vac', undefined, (path) =>
        path === '/Library/Application Support/Voice Vac/asr-venv/bin/python'
      )
    ).toBe('/Library/Application Support/Voice Vac/asr-venv/bin/python');
  });

  it('falls back to the system Python with a clear installer path available', () => {
    expect(resolvePythonCommand('/Library/Application Support/Voice Vac', undefined, () => false)).toBe('python3');
  });
});
