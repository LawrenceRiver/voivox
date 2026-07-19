import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type VoiceVacAssetState = 'idle' | 'drag' | 'stretch' | 'snap' | 'suction' | 'complete' | 'collapse' | 'error';

export class VoiceVacAsset {
  readonly group = new THREE.Group();
  private readonly loader = new GLTFLoader();
  private mixer?: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private activeAction?: THREE.AnimationAction;
  private loaded = false;

  async load(scene: THREE.Scene, url: string): Promise<void> {
    const gltf = await this.loader.loadAsync(url);
    this.group.clear();
    this.group.add(gltf.scene);
    // Blender is Z-up; the Voice Vac stage is Y-up.
    this.group.rotation.x = -Math.PI / 2;
    this.group.scale.setScalar(.94);
    gltf.scene.traverse((object) => {
      if (object.name === 'HoseMesh' || object.name.startsWith('HoseSleeve')) object.visible = false;
    });
    scene.add(this.group);
    this.mixer = new THREE.AnimationMixer(gltf.scene);
    for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
    this.loaded = true;
    this.setState('idle');
  }

  setState(state: VoiceVacAssetState): void {
    if (!this.loaded) return;
    const next = this.actions.get(state) ?? this.actions.get('idle');
    if (!next || next === this.activeAction) return;
    next.reset().fadeIn(.16).play();
    this.activeAction?.fadeOut(.16);
    this.activeAction = next;
  }

  update(deltaSeconds: number): void {
    this.mixer?.update(deltaSeconds);
  }

  setHoseTarget(point: THREE.Vector3): void {
    this.group.userData.hoseTarget = point.clone();
  }

  setNozzleStagePosition(x: number, y: number): void {
    const nozzle = this.group.getObjectByName('NozzleRoot');
    if (!nozzle) return;
    nozzle.position.set(x, 0, y);
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      if (Array.isArray(object.material)) object.material.forEach((item) => item.dispose());
      else object.material.dispose();
    });
    this.group.clear();
    this.actions.clear();
    this.mixer = undefined;
    this.activeAction = undefined;
    this.loaded = false;
  }
}
