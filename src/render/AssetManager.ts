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
 *   - opzionali: materiale `accent` (strisce, colore a contrasto automatico) e
 *     `number` (riceve la texture con il numero di gara)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { CarParams } from '../physics/CarParams';
import { WHEEL_NAMES } from '../physics/Vehicle';
import { accentFor, buildPlaceholderCar, numberTexture } from './PlaceholderCar';

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

export async function loadCarRig(car: CarParams, paintColor: THREE.ColorRepresentation, raceNumber = 1): Promise<CarRig> {
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
  return rigCar(scene, paintColor, raceNumber, source);
}

/**
 * Copia del modello già montato (per i bot): stessa geometria, livrea di un altro colore.
 * Le geometrie sono condivise, quindi 20 auto costano poco in memoria.
 */
export function cloneRig(src: CarRig, paintColor: THREE.ColorRepresentation, raceNumber?: number): CarRig {
  const root = src.root.clone(true);
  const byName = (name: string) => root.getObjectByName(name) ?? null;
  applyLivery(root, paintColor, raceNumber);
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

/**
 * Livrea: ricolora i materiali `paint` (colore scelto) e `accent` (contrasto),
 * mette il numero di gara sui materiali `number`. I materiali sono copiati,
 * quindi l'originale (e le altre auto) non cambiano.
 */
function applyLivery(root: THREE.Object3D, paintColor: THREE.ColorRepresentation, raceNumber?: number): void {
  const paint = new THREE.Color(paintColor);
  const accent = accentFor(paint);
  const cache = new Map<THREE.Material, THREE.Material>();
  const swap = (m: THREE.Material): THREE.Material => {
    const n = m.name.toLowerCase();
    const kind = n.startsWith('paint') ? 'paint' : n.startsWith('accent') ? 'accent' : n.startsWith('number') && raceNumber !== undefined ? 'number' : null;
    if (!kind) return m;
    if (!cache.has(m)) {
      const c = (m as THREE.MeshStandardMaterial).clone();
      if (kind === 'paint') c.color = paint.clone();
      else if (kind === 'accent') c.color = accent.clone();
      else c.map = numberTexture(raceNumber!);
      cache.set(m, c);
    }
    return cache.get(m)!;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
}

function rigCar(scene: THREE.Object3D, paintColor: THREE.ColorRepresentation, raceNumber: number, source: CarRig['source']): CarRig {
  const root = new THREE.Group();
  root.name = 'car_root';
  const body = new THREE.Group();
  body.name = 'car_body';
  root.add(body);
  body.add(scene);
  scene.updateMatrixWorld(true);

  // Ombre e livrea
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = !mesh.userData.noShadow;
    mesh.receiveShadow = true;
  });
  applyLivery(scene, paintColor, raceNumber);

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
