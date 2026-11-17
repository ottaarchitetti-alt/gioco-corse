/**
 * Caricamento dei modelli 3D delle auto.
 *
 * Prova a caricare il GLB indicato nel file .car.json. Se non c'è (o non si
 * carica) costruisce un SEGNAPOSTO che rispetta la STESSA convenzione dei nomi.
 * Il resto del gioco non sa quale dei due sta usando.
 *
 * CONVENZIONE (vedi public/models/LEGGIMI.md per la guida Blender completa)
 *   - unità: metri; origine a terra, centrata, a metà tra i due assi
 *   - muso verso +Z (in Blender: verso -Y, con export "+Y Up")
 *   - ruote: oggetti `wheel_FL`, `wheel_FR`, `wheel_RL`, `wheel_RR`, origine al centro mozzo
 *   - opzionali: `steering_wheel`, empty `cam_cockpit` e `cam_hood`
 *   - materiale `paint`: ricolorato per dare livree diverse
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { CarParams } from '../physics/CarParams';
import { WHEEL_NAMES } from '../physics/Vehicle';

/** Il modello "montato", pronto per essere animato da CarView. */
export interface CarRig {
  /** Nodo radice: posizione = origine del modello, rotazione = imbardata */
  root: THREE.Group;
  /** Carrozzeria: riceve beccheggio e rollio */
  body: THREE.Group;
  /** Per ogni ruota: perno di sterzo (rot. Y) → rotore (rot. X) → modello ruota */
  wheelPivots: THREE.Group[];
  wheelSpinners: THREE.Group[];
  /** Perno del volante (rot. Z), se presente */
  steeringWheel: THREE.Group | null;
  camCockpit: THREE.Object3D | null;
  camHood: THREE.Object3D | null;
  /** Geometria letta dalle ruote del modello (se tutte e 4 presenti) */
  measured: { wheelbase: number; trackFront: number; trackRear: number; wheelRadius: number } | null;
  source: 'glb' | 'segnaposto';
}

const loader = new GLTFLoader();

export async function loadCarRig(car: CarParams, paintColor: THREE.ColorRepresentation): Promise<CarRig> {
  let scene: THREE.Object3D | null = null;
  if (car.model) {
    try {
      const gltf = await loader.loadAsync(car.model);
      scene = gltf.scene;
      console.info(`[AssetManager] Modello caricato: ${car.model}`);
    } catch {
      console.info(`[AssetManager] ${car.model} non trovato: uso il segnaposto.`);
    }
  }
  const source = scene ? 'glb' : 'segnaposto';
  if (!scene) scene = buildPlaceholderCar(car);
  return rigCar(scene, paintColor, source);
}

/**
 * Copia del modello già montato (per i bot): stessa geometria, livrea di un altro colore.
 * Le geometrie sono condivise, quindi 20 auto costano poco in memoria.
 */
export function cloneRig(src: CarRig, paintColor: THREE.ColorRepresentation): CarRig {
  const root = src.root.clone(true);
  const byName = (name: string) => root.getObjectByName(name) ?? null;
  const paint = new THREE.Color(paintColor);
  const cache = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const swap = (m: THREE.Material) => {
      if (!m.name.toLowerCase().startsWith('paint')) return m;
      if (!cache.has(m)) {
        const c = (m as THREE.MeshStandardMaterial).clone();
        c.color = paint.clone();
        cache.set(m, c);
      }
      return cache.get(m)!;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  const wheelPivots = WHEEL_NAMES.map((n) => byName(n + '_pivot') as THREE.Group);
  return {
    root,
    body: byName('car_body') as THREE.Group,
    wheelPivots,
    wheelSpinners: wheelPivots.map((p) => p.children[0] as THREE.Group),
    steeringWheel: src.steeringWheel ? (byName('steering_wheel')?.parent as THREE.Group) ?? null : null,
    camCockpit: byName('cam_cockpit'),
    camHood: byName('cam_hood'),
    measured: src.measured,
    source: src.source,
  };
}

/** Cerca un oggetto per nome (senza distinguere maiuscole; accetta suffissi tipo ".001"). */
function findByName(root: THREE.Object3D, name: string): THREE.Object3D | null {
  const target = name.toLowerCase();
  let found: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (found) return;
    const n = o.name.toLowerCase();
    if (n === target || n.startsWith(target + '.') || n.startsWith(target + '_0')) found = o;
  });
  return found;
}

function rigCar(scene: THREE.Object3D, paintColor: THREE.ColorRepresentation, source: CarRig['source']): CarRig {
  const root = new THREE.Group();
  root.name = 'car_root';
  const body = new THREE.Group();
  body.name = 'car_body';
  root.add(body);
  body.add(scene);
  scene.updateMatrixWorld(true);

  // Ombre e ricolorazione del materiale "paint"
  const paint = new THREE.Color(paintColor);
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m, i) => {
      if (m.name.toLowerCase().startsWith('paint')) {
        const c = (m as THREE.MeshStandardMaterial).clone();
        c.color = paint.clone();
        if (Array.isArray(mesh.material)) mesh.material[i] = c;
        else mesh.material = c;
      }
    });
  });

  // Ruote: le spostiamo dal corpo (che si inclina) alla radice (che non si inclina)
  const wheelPivots: THREE.Group[] = [];
  const wheelSpinners: THREE.Group[] = [];
  const wheelPos: (THREE.Vector3 | null)[] = [];
  let radius = 0;
  for (const name of WHEEL_NAMES) {
    const pivot = new THREE.Group();
    pivot.name = name + '_pivot';
    const spinner = new THREE.Group();
    pivot.add(spinner);
    root.add(pivot);
    wheelPivots.push(pivot);
    wheelSpinners.push(spinner);

    const wheel = findByName(scene, name);
    if (!wheel) {
      wheelPos.push(null);
      continue;
    }
    const p = new THREE.Vector3();
    wheel.getWorldPosition(p);
    const box = new THREE.Box3().setFromObject(wheel);
    radius = Math.max(radius, (box.max.y - box.min.y) / 2);
    pivot.position.copy(p);
    // Conserviamo rotazione/scala della ruota, azzeriamo solo la posizione
    const q = new THREE.Quaternion(), s = new THREE.Vector3();
    wheel.getWorldQuaternion(q);
    wheel.getWorldScale(s);
    wheel.removeFromParent();
    wheel.position.set(0, 0, 0);
    wheel.quaternion.copy(q);
    wheel.scale.copy(s);
    spinner.add(wheel);
    wheelPos.push(p);
  }

  let measured: CarRig['measured'] = null;
  if (wheelPos.every((p) => p)) {
    const [fl, fr, rl, rr] = wheelPos as THREE.Vector3[];
    measured = {
      wheelbase: (fl.z + fr.z) / 2 - (rl.z + rr.z) / 2,
      trackFront: Math.abs(fl.x - fr.x),
      trackRear: Math.abs(rl.x - rr.x),
      wheelRadius: radius,
    };
  }

  // Volante: lo avvolgiamo in un perno che ruota attorno all'asse Z (avanti)
  let steeringWheel: THREE.Group | null = null;
  const sw = findByName(scene, 'steering_wheel');
  if (sw && sw.parent) {
    steeringWheel = new THREE.Group();
    steeringWheel.position.copy(sw.position);
    sw.parent.add(steeringWheel);
    sw.position.set(0, 0, 0);
    steeringWheel.add(sw);
  }

  return {
    root, body, wheelPivots, wheelSpinners, steeringWheel,
    camCockpit: findByName(scene, 'cam_cockpit'),
    camHood: findByName(scene, 'cam_hood'),
    measured, source,
  };
}

/**
 * Auto segnaposto costruita con forme semplici, nel formato di un GLB "corretto".
 * Le misure arrivano dal file .car.json.
 */
function buildPlaceholderCar(car: CarParams): THREE.Group {
  const g = new THREE.Group();
  const L = car.wheelbase, r = car.wheelRadius;

  const paint = new THREE.MeshStandardMaterial({ name: 'paint', color: '#ffffff', roughness: 0.35, metalness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: '#16181c', roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: '#20303f', roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.55 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, name = '') => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.name = name;
    g.add(m);
    return m;
  };

  // Carrozzeria
  add(new THREE.BoxGeometry(1.98, 0.62, 4.55), paint, 0, 0.45, 0.05, 'body');
  add(new THREE.BoxGeometry(1.5, 0.42, 2.0), glass, 0, 0.97, -0.35, 'cabin');
  add(new THREE.BoxGeometry(1.52, 0.06, 1.7), paint, 0, 1.2, -0.45, 'roof');
  add(new THREE.BoxGeometry(1.48, 0.02, 1.66), dark, 0, 1.165, -0.45, 'headliner'); // cielo interno scuro
  add(new THREE.BoxGeometry(2.0, 0.05, 0.4), dark, 0, 0.12, 2.3, 'splitter');
  add(new THREE.BoxGeometry(1.85, 0.06, 0.38), dark, 0, 1.22, -2.05, 'wing');
  add(new THREE.BoxGeometry(0.06, 0.4, 0.2), dark, 0.55, 0.98, -2.0);
  add(new THREE.BoxGeometry(0.06, 0.4, 0.2), dark, -0.55, 0.98, -2.0);
  add(new THREE.BoxGeometry(1.4, 0.14, 0.3), dark, 0, 0.84, 0.4, 'dashboard');
  const lightMat = new THREE.MeshStandardMaterial({ color: '#ff2a1a', emissive: '#550000' });
  add(new THREE.BoxGeometry(0.5, 0.08, 0.03), lightMat, 0.6, 0.6, -2.18);
  add(new THREE.BoxGeometry(0.5, 0.08, 0.03), lightMat, -0.6, 0.6, -2.18);

  // Ruote: nodo vuoto al centro mozzo + geometria, asse di rotazione = X
  const tyreGeo = new THREE.CylinderGeometry(r, r, 0.3, 28);
  tyreGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.31, 20);
  rimGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.32, r * 1.15, 0.07);
  const rimMat = new THREE.MeshStandardMaterial({ color: '#9aa3ad', roughness: 0.3, metalness: 0.8 });
  const tyreMat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.9 });
  const wheelDefs: [string, number, number][] = [
    ['wheel_FL', car.trackFront / 2, L / 2],
    ['wheel_FR', -car.trackFront / 2, L / 2],
    ['wheel_RL', car.trackRear / 2, -L / 2],
    ['wheel_RR', -car.trackRear / 2, -L / 2],
  ];
  for (const [name, x, z] of wheelDefs) {
    const w = new THREE.Group();
    w.name = name;
    w.position.set(x, r, z);
    w.add(new THREE.Mesh(tyreGeo, tyreMat), new THREE.Mesh(rimGeo, rimMat));
    const sp1 = new THREE.Mesh(spokeGeo, dark);
    const sp2 = sp1.clone();
    sp2.rotation.x = Math.PI / 2;
    w.add(sp1, sp2);
    g.add(w);
  }

  // Volante (guida a sinistra = +X)
  const sw = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.018, 8, 24), dark);
  sw.name = 'steering_wheel';
  sw.position.set(0.38, 0.86, 0.22);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.03, 0.02), dark);
  sw.add(bar);
  g.add(sw);

  // Punti telecamera
  const cockpit = new THREE.Object3D();
  cockpit.name = 'cam_cockpit';
  cockpit.position.set(0.38, 1.06, -0.5);
  const hood = new THREE.Object3D();
  hood.name = 'cam_hood';
  hood.position.set(0, 1.0, 0.95);
  g.add(cockpit, hood);
  return g;
}
