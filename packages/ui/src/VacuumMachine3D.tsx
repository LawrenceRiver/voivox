import { useEffect, useRef, useState, type PointerEvent } from 'react';
import * as THREE from 'three';

import type { TunnelLocale } from './tunnel-state.js';
import { VoiceVacAsset } from './VoiceVacAsset.js';

export type VacuumMachine3DProps = {
  active: boolean;
  completed: boolean;
  locale: TunnelLocale;
  onTargetDrop?: () => void;
};

function material(color: number, options: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: .28, metalness: .12, ...options });
}

function addEye(group: THREE.Group, x: number): void {
  const eye = new THREE.Mesh(new THREE.SphereGeometry(.16, 12, 10), material(0x506f7d, { roughness: .18, metalness: .2 }));
  eye.position.set(x, -.12, .48);
  group.add(eye);
  const glint = new THREE.Mesh(new THREE.SphereGeometry(.045, 8, 8), material(0xffffff, { roughness: .1 }));
  glint.position.set(x - .045, -.18, .61);
  group.add(glint);
}

const FOLD_POSITIONS = [.12, .24, .39, .53, .68, .81, .93];

function foldedHoseCurve(extension = 0, phase = 0): THREE.CatmullRomCurve3 {
  const points: THREE.Vector3[] = [];
  const length = 2.78 + extension * 1.16;
  for (let index = 0; index <= 9; index += 1) {
    const t = index / 9;
    const fold = FOLD_POSITIONS.reduce((sum, position, foldIndex) => (
      sum + Math.exp(-(((t - position) / .045) ** 2)) * Math.sin((t - position) * 46 + foldIndex * .8 + phase)
    ), 0);
    const bend = Math.sin(t * Math.PI) * .3;
    points.push(new THREE.Vector3(
      -3.25 + bend + fold * (.08 + extension * .018),
      -.98 - length * t + Math.sin(t * Math.PI * 2 + phase) * .045 + fold * .05,
      .1 + Math.cos(t * Math.PI) * .05
    ));
  }
  return new THREE.CatmullRomCurve3(points, false, 'centripetal', .42);
}

function createCorrugatedHose(scene: THREE.Scene): { hose: THREE.Mesh; rings: THREE.Mesh[]; curve: THREE.CatmullRomCurve3 } {
  const curve = foldedHoseCurve();
  const hose = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 32, .19, 10, false),
    material(0x9aacb5, { roughness: .42, metalness: .05 })
  );
  scene.add(hose);
  const rings: THREE.Mesh[] = [];
  const ringMaterial = material(0x70848e, { roughness: .36, metalness: .16 });
  for (let index = 0; index < 14; index += 1) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(.22, .035, 6, 16), ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.userData.phase = index / 14;
    rings.push(ring);
    scene.add(ring);
  }
  return { hose, rings, curve };
}

function createScene(canvas: HTMLCanvasElement, width: number, height: number, active: boolean, completed: boolean): { dispose: () => void; updateDrag: (distance: number) => void } {
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    return { dispose: () => undefined, updateDrag: () => undefined };
  }
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, canvas, powerPreference: 'high-performance' });
  } catch {
    return { dispose: () => undefined, updateDrag: () => undefined };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-7, 7, 4.4, -4.4, .1, 100);
  camera.position.set(0, 0, 20);
  camera.lookAt(0, 0, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc4d1d7, 2.3));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(-4, 7, 12);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xadd7e5, 1.4);
  rim.position.set(8, -1, 8);
  scene.add(rim);

  const asset = new VoiceVacAsset();
  const assetUrl = new URL('./assets/voice-vac-machine.glb', import.meta.url).href;

  const shellMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xf5f9fb,
    clearcoat: .9,
    clearcoatRoughness: .08,
    metalness: .08,
    opacity: .82,
    roughness: .06,
    transmission: .36,
    transparent: true
  });
  const shell = new THREE.Mesh(new THREE.CapsuleGeometry(1.22, 6.4, 8, 32), shellMaterial);
  shell.rotation.z = Math.PI / 2;
  shell.scale.set(1, 1, .58);
  shell.position.set(0, .25, -.2);
  scene.add(shell);

  const portMaterial = new THREE.MeshPhysicalMaterial({ color: 0xe7f0f3, clearcoat: 1, opacity: .96, roughness: .07, transmission: .2, transparent: true });
  const legacyPorts: THREE.Object3D[] = [];
  for (const x of [-3.4, 3.2]) {
    const port = new THREE.Mesh(new THREE.CylinderGeometry(1.03, 1.03, .18, 40), portMaterial);
    port.rotation.x = Math.PI / 2;
    port.position.set(x, .2, .38);
    scene.add(port);
    legacyPorts.push(port);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.02, .085, 10, 40), material(0xc6d5db, { roughness: .2, metalness: .3 }));
    ring.position.set(x, .2, .54);
    scene.add(ring);
    legacyPorts.push(ring);
  }

  const hoseScene = createCorrugatedHose(scene);
  const nozzle = new THREE.Group();
  nozzle.position.set(-3.35, -1.9, .48);
  nozzle.rotation.z = -.05;
  const nozzleBody = new THREE.Mesh(new THREE.SphereGeometry(.78, 24, 16), new THREE.MeshPhysicalMaterial({ color: 0xe6eef1, clearcoat: .85, roughness: .12, metalness: .14 }));
  nozzleBody.scale.set(1.1, .58, .58);
  nozzle.add(nozzleBody);
  const nozzleRim = new THREE.Mesh(new THREE.TorusGeometry(.51, .1, 10, 24), material(0xb7c8cf, { roughness: .2, metalness: .22 }));
  nozzleRim.rotation.x = Math.PI / 2;
  nozzleRim.position.z = .5;
  nozzle.add(nozzleRim);
  addEye(nozzle, -.27);
  addEye(nozzle, .27);
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(.16, .045, 8, 16, Math.PI), material(0x6f848e, { roughness: .3 }));
  mouth.rotation.z = Math.PI;
  mouth.position.set(0, -.38, .52);
  nozzle.add(mouth);
  scene.add(nozzle);

  const legacyBody = new THREE.Group();
  legacyBody.add(shell);
  scene.add(legacyBody);
  legacyPorts.forEach((child) => {
    scene.remove(child);
    legacyBody.add(child);
  });
  let glbReady = false;
  void asset.load(scene, assetUrl).then(() => {
    glbReady = true;
    legacyBody.visible = false;
    nozzle.visible = false;
    asset.setState(completed ? 'complete' : active ? 'suction' : 'idle');
    asset.setNozzleStagePosition(-3.35, -1.9);
  }).catch(() => {
    glbReady = false;
  });

  let currentDistance = 0;
  const redrawHose = (distance: number, phase = 0): void => {
    currentDistance = distance;
    const extension = Math.min(distance / 70, 1.45);
    const nextCurve = foldedHoseCurve(extension, phase);
    hoseScene.hose.geometry.dispose();
    hoseScene.hose.geometry = new THREE.TubeGeometry(nextCurve, 32, .19, 10, false);
    hoseScene.rings.forEach((ring, index) => {
      const point = nextCurve.getPointAt((index + 1) / (hoseScene.rings.length + 1));
      ring.position.copy(point);
    });
    const nozzleX = -3.35 - extension * .25;
    const nozzleY = -1.9 - extension;
    nozzle.position.y = nozzleY;
    nozzle.position.x = nozzleX;
    if (glbReady) asset.setNozzleStagePosition(nozzleX, nozzleY);
  };
  redrawHose(0);
  const clock = new THREE.Clock();
  let frame = 0;
  const render = (): void => {
    const delta = clock.getDelta();
    const elapsed = clock.elapsedTime;
    asset.update(delta);
    if (active) {
      redrawHose(Math.max(currentDistance, 18), elapsed * 1.8);
      nozzle.rotation.z = -.05 + Math.sin(elapsed * 5) * .025;
      hoseScene.rings.forEach((ring, index) => {
        const pulse = .92 + Math.sin(elapsed * 6 - index * .55) * .08;
        ring.scale.setScalar(pulse);
      });
    }
    renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
  };
  render();
  return {
    dispose: () => {
      cancelAnimationFrame(frame);
      renderer.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) object.material.forEach((item) => item.dispose());
          else object.material.dispose();
        }
      });
      asset.dispose();
    },
    updateDrag: redrawHose
  };
}

export function VacuumMachine3D({ active, completed, locale, onTargetDrop }: VacuumMachine3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualRef = useRef<ReturnType<typeof createScene> | undefined>(undefined);
  const [drag, setDrag] = useState(0);
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);
  const label = locale === 'zh-CN' ? '连接到视频' : 'Connect to video';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const parent = canvas.parentElement;
    if (!parent) return undefined;
    const rect = parent.getBoundingClientRect();
    visualRef.current = createScene(canvas, Math.max(1, rect.width), Math.max(1, rect.height), active, completed);
    return () => {
      visualRef.current?.dispose();
      visualRef.current = undefined;
    };
  }, [active, completed]);

  useEffect(() => {
    visualRef.current?.updateDrag(drag);
  }, [drag]);

  function down(event: PointerEvent<HTMLButtonElement>): void {
    origin.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }
  function move(event: PointerEvent<HTMLButtonElement>): void {
    if (dragging) setDrag(Math.max(0, Math.min(150, event.clientY - origin.current)));
  }
  function up(): void {
    setDragging(false);
    setDrag(0);
    onTargetDrop?.();
  }

  return (
    <div className={`vacuum-3d-stage ${dragging ? 'is-dragging' : ''} ${active ? 'is-active' : ''} ${completed ? 'is-complete' : ''}`}>
      <div aria-hidden="true" className="vacuum-3d-fallback">
        <div className="fallback-capsule"><i className="fallback-port fallback-port--left" /><i className="fallback-port fallback-port--right" /></div>
        <div className="fallback-hose"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
        <div className="fallback-nozzle"><i /><i /><b /></div>
      </div>
      <canvas aria-hidden="true" data-engine="three.js r177" ref={canvasRef} />
      <button
        aria-label={label}
        className="vacuum-3d-drag-handle"
        onPointerCancel={up}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        type="button"
      />
    </div>
  );
}
