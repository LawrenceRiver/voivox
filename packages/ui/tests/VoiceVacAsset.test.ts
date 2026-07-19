import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VoiceVacAsset } from '../src/VoiceVacAsset.js';

describe('VoiceVacAsset', () => {
  it('provides a disposable scene asset controller before loading', () => {
    const asset = new VoiceVacAsset();
    expect(asset.group.type).toBe('Group');
    asset.setState('stretch');
    asset.setHoseTarget(new THREE.Vector3(1, 2, 3));
    asset.dispose();
    expect(asset.group.children).toHaveLength(0);
  });
});
