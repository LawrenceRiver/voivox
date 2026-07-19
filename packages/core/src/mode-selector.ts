import type { TranscriptionMode } from './pvtt-contract.js';

export type ModeDecision = {
  requested: TranscriptionMode;
  selected: 'live' | 'accelerated';
  reason: 'media_accessible' | 'media_unavailable' | 'forced_live' | 'forced_accelerated';
};

export function selectProcessingMode(input: {
  requested: TranscriptionMode;
  mediaAccessible: boolean;
}): ModeDecision {
  if (input.requested === 'live') {
    return { requested: input.requested, selected: 'live', reason: 'forced_live' };
  }
  if (input.requested === 'accelerated' && input.mediaAccessible) {
    return { requested: input.requested, selected: 'accelerated', reason: 'forced_accelerated' };
  }
  if (input.requested === 'auto' && input.mediaAccessible) {
    return { requested: input.requested, selected: 'accelerated', reason: 'media_accessible' };
  }
  return { requested: input.requested, selected: 'live', reason: 'media_unavailable' };
}
