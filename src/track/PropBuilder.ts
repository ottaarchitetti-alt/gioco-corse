/**
 * Oggetti di contorno in 3D. Forme semplici "segnaposto" costruite via codice;
 * il tipo "modello" carica un tuo GLB da Blender.
 *
 * Convenzione (uguale alle auto): origine a terra al centro, lunghezza lungo X,
 * lato "frontale" verso +Z (es. le tribune guardano verso +Z).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PROP_CATALOG } from './props';
import type { PropItem } from './TrackData';

const mats = {
  concrete: new THREE.MeshStandardMaterial({ color: '#b9b4ab', roughness: 0.9 }),
  seats: new THREE.MeshStandardMaterial({ color: '#2f6fb3', roughness: 0.7 }),
  metal: new THREE.MeshStandardMaterial({ color: '#c9ced6', roughness: 0.35, metalness: 0.8 }),
  tyre: new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 0.95 }),
  tyreBand: new THREE.MeshStandardMaterial({ color: '#d7d7d7', roughness: 0.8 }),
  trunk: new THREE.MeshStandardMaterial({ color: '#5a3d26', roughness: 1 }),
  leaves: new THREE.MeshStandardMaterial({ color: '#2f5a2a', roughness: 1 }),
  building: new THREE.MeshStandardMaterial({ color: '#d8d2c6', roughness: 0.85 }),
  glass: new THREE.MeshStandardMaterial({ color: '#30485e', roughness: 0.15, metalness: 0.3 }),
  board: new THREE.MeshStandardMaterial({ color: '#e0a030', roughness: 0.6 }),
  missing: new THREE.MeshStandardMaterial({ color: '#c56cf0', roughness: 0.6 }),
};

const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = h / 2, z = 0) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

const gltfLoader = new GLTFLoader();

export function buildProp(p: PropItem): THREE.Object3D {
  const g = new THREE.Group();
  const L = p.size;
  const D = PROP_CATALOG[p.type].depth(L);
  switch (p.type) {
    case 'tribuna': {
      // gradoni che salgono allontanandosi dal fronte (+Z)
      const tiers = 6, step = D / tiers;
      for (let k = 0; k < tiers; k++) {
        const h = 0.8 + k * 0.75;
        g.add(box(L, h, step, mats.concrete, 0, h / 2, D / 2 - (k + 0.5) * step));
        g.add(box(L, 0.12, step * 0.5, mats.seats, 0, h + 0.06, D / 2 - (k + 0.35) * step));
      }
      g.add(box(L, 7, 0.4, mats.concrete, 0, 3.5, -D / 2)); // muro posteriore
      g.add(box(L + 1, 0.3, D + 2, mats.metal, 0, 8, 0)); // tettoia
      break;
    }
    case 'barriera': {
      for (let x = -L / 2; x <= L / 2 + 0.01; x += 4) g.add(box(0.12, 0.75, 0.12, mats.metal, x, 0.375, 0));
      g.add(box(L, 0.32, 0.08, mats.metal, 0, 0.6, 0.08));
      break;
    }
    case 'muro':
      g.add(box(L, 1.0, D, mats.concrete));
      break;
    case 'gomme':
      g.add(box(L, 0.9, D, mats.tyre, 0, 0.45));
      g.add(box(L, 0.12, D + 0.02, mats.tyreBand, 0, 0.75));
      break;
    case 'albero': {
      const k = L / 7;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25 * k, 0.35 * k, 3 * k, 6), mats.trunk);
      trunk.position.y = 1.5 * k;
      const crown = new THREE.Mesh(new THREE.ConeGeometry(L / 2, 7 * k, 8), mats.leaves);
      crown.position.y = 6 * k;
      trunk.castShadow = crown.castShadow = true;
      g.add(trunk, crown);
      break;
    }
    case 'edificio': {
      g.add(box(L, 8, D, mats.building));
      g.add(box(L * 0.9, 1.6, 0.05, mats.glass, 0, 5.5, D / 2 + 0.03));
      g.add(box(L * 0.9, 1.6, 0.05, mats.glass, 0, 2.5, D / 2 + 0.03));
      break;
    }
    case 'cartellone':
      g.add(box(0.2, 3, 0.2, mats.metal, -L / 2 + 0.5, 1.5, 0), box(0.2, 3, 0.2, mats.metal, L / 2 - 0.5, 1.5, 0));
      g.add(box(L, 2, 0.2, mats.board, 0, 3.6, 0));
      break;
    case 'modello': {
      // segnaposto finché il GLB non è caricato (o se manca)
      const ph = box(L, L * 0.3, L * 0.3, mats.missing);
      g.add(ph);
      if (p.model) {
        gltfLoader.loadAsync(p.model).then(
          (gltf) => {
            const m = gltf.scene;
            const bb = new THREE.Box3().setFromObject(m);
            const len = Math.max(0.01, bb.max.x - bb.min.x);
            m.scale.setScalar(L / len); // la "lunghezza" dell'oggetto = dimensione lungo X
            m.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true; });
            g.remove(ph);
            g.add(m);
          },
          () => console.warn(`[Oggetti] modello non trovato: ${p.model}`),
        );
      }
      break;
    }
  }
  g.position.set(p.x, 0, p.z);
  g.rotation.y = (p.rot * Math.PI) / 180;
  g.name = `prop_${p.type}`;
  return g;
}
