import { describe, expect, it } from 'vitest';

import { selectProcessingMode } from '../src/mode-selector.js';

describe('PVTT automatic mode selection', () => {
  it('selects accelerated mode only when media bytes are accessible', () => {
    expect(selectProcessingMode({ requested: 'auto', mediaAccessible: true })).toEqual({
      requested: 'auto',
      selected: 'accelerated',
      reason: 'media_accessible'
    });
    expect(selectProcessingMode({ requested: 'auto', mediaAccessible: false })).toEqual({
      requested: 'auto',
      selected: 'live',
      reason: 'media_unavailable'
    });
  });

  it('respects explicit live and accelerated choices', () => {
    expect(selectProcessingMode({ requested: 'live', mediaAccessible: true })).toMatchObject({ selected: 'live', reason: 'forced_live' });
    expect(selectProcessingMode({ requested: 'accelerated', mediaAccessible: false })).toMatchObject({ selected: 'live', reason: 'media_unavailable' });
  });
});
