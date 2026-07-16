import { describe, expect, it } from 'vitest';

import { presentMacApplications } from '../src/renderer/mac-process-picker.js';

describe('macOS application picker', () => {
  it('hides anonymous audio-process rows and deduplicates visible applications', () => {
    expect(presentMacApplications([
      { bundleId: '', name: 'Audio process 517', pid: 517 },
      { bundleId: 'com.apple.Safari', name: 'Safari', pid: 101 },
      { bundleId: 'com.apple.Safari', name: 'Safari', pid: 102 },
      { bundleId: 'com.spotify.client', name: 'Spotify', pid: 202 }
    ])).toEqual([
      { bundleId: 'com.apple.Safari', name: 'Safari', pid: 101 },
      { bundleId: 'com.spotify.client', name: 'Spotify', pid: 202 }
    ]);
  });
});
