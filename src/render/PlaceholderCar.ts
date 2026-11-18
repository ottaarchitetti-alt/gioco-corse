/**
 * AUTO SEGNAPOSTO "GT" costruita via codice (finché non metti il tuo GLB).
 *
 * La carrozzeria è un "loft": tante sezioni trasversali (larghezza, altezza
 * della fiancata, del cofano, passaruota) unite tra loro lungo l'auto, come
 * le ordinate di uno scafo. Sopra c'è l'abitacolo (vetri + tetto + montanti),
 * poi i dettagli: fari, prese d'aria, splitter, minigonne, specchietti, ala
 * posteriore con profilo alare, diffusore, scarichi, interni con roll-bar.
 * Le ruote hanno pneumatico arrotondato, cerchio a 10 razze e disco freno.
 *
 * Rispetta la stessa convenzione dei nomi di un GLB (vedi AssetManager):
 *  - materiale `paint`  → colore della livrea
 *  - materiale `accent` → strisce (colore a contrasto, scelto in automatico)
 *  - materiale `number` → tondi con il numero di gara
 * Per non pesare con 20 auto in pista, i pezzi fissi vengono fusi in poche
 * mesh (una per materiale).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarParams } from '../physics/CarParams';

type P2 = [number, number];

// ----------------------------------------------------------------------------
// Profili della carrozzeria (z = avanti, metri dal centro del passo)
// ----------------------------------------------------------------------------

/** z, semilarghezza, altezza spalla (bordo fiancata), altezza centro cofano/tetto, fondo */
const BODY_KEYS: number[][] = [
  [2.33, 0.7, 0.4, 0.38, 0.2],
  [2.25, 0.88, 0.53, 0.48, 0.13],
  [2.05, 0.97, 0.66, 0.58, 0.12],
  [1.7, 1.0, 0.8, 0.68, 0.12],
  [1.33, 1.005, 0.86, 0.72, 0.12],
  [0.95, 0.99, 0.85, 0.78, 0.12],
  [0.7, 0.97, 0.845, 0.83, 0.12],
  [0.2, 0.945, 0.86, 0.86, 0.12],
  [-0.6, 0.95, 0.87, 0.87, 0.12],
  [-1.0, 0.99, 0.9, 0.88, 0.12],
  [-1.33, 1.02, 0.93, 0.9, 0.12],
  [-1.8, 1.0, 0.93, 0.9, 0.14],
  [-2.1, 0.95, 0.91, 0.89, 0.2],
  [-2.27, 0.88, 0.86, 0.85, 0.28],
];
const Z_FRONT = 2.33, Z_REAR = -2.27;

/** Abitacolo: z, semilarghezza in alto, altezza tetto */
const CABIN_KEYS: number[][] = [
  [0.8, 0.8, 0.845],
  [0.25, 0.66, 1.13],
  [-0.15, 0.63, 1.21],
  [-0.65, 0.63, 1.22],
  [-1.1, 0.66, 1.15],
  [-1.55, 0.72, 1.01],
  [-1.92, 0.8, 0.925],
];
const CAB_FRONT = 0.8, CAB_REAR = -1.92;

/** Interpolazione lineare tra le chiavi, poi media mobile per ammorbidire le linee. */
function profile(keys: number[][]): (z: number) => number[] {
  const lin = (z: number): number[] => {
    const zs = keys.map((k) => k[0]);
    if (z >= zs[0]) return keys[0].slice(1);
    if (z <= zs[zs.length - 1]) return keys[keys.length - 1].slice(1);
    let i = 0;
    while (zs[i + 1] > z) i++;
    const a = keys[i], b = keys[i + 1];
    const t = (z - a[0]) / (b[0] - a[0]);
    return a.slice(1).map((v, j) => v + (b[j + 1] - v) * t);
  };
  const offs = [-0.12, -0.06, 0, 0.06, 0.12];
  const lo = keys[keys.length - 1][0], hi = keys[0][0];
  return (z) => {
    const acc = lin(z).map(() => 0);
    for (const o of offs) lin(Math.min(hi, Math.max(lo, z + o))).forEach((v, j) => (acc[j] += v / offs.length));
    return acc;
  };
}
const bodyAt = profile(BODY_KEYS);
const cabinAt = profile(CABIN_KEYS);

/** Campioni lungo z (da avanti a dietro), con punti extra sui bordi indicati. */
function zSamples(z0: number, z1: number, step: number, extra: number[] = []): number[] {
  const out: number[] = [];
  for (let z = z0; z > z1; z -= step) out.push(z);
  out.push(z1);
  for (const e of extra) if (e < z0 && e > z1) out.push(e);
  return [...new Set(out)].sort((a, b) => b - a);
}

/** Mezza sezione della carrozzeria (lato +x), dal fondo al centro del cofano/tetto. */
function bodyHalf(z: number, archY: number): P2[] {
  const [hw, ys, yc, yb] = bodyAt(z);
  const ya = Math.max(yb, archY);
  const h = ys - ya;
  const c = Math.min(0.06, h * 0.25);
  const xin = Math.min(0.62, hw * 0.7);
  return [
    [0, yb],
    [xin, yb],
    [xin + 0.04, ya],
    [hw - c, ya],
    [hw - c * 0.3, ya + c * 0.7],
    [hw, ya + h * 0.45],
    [hw - 0.015, ya + h * 0.8],
    [hw - 0.05, ys - 0.012],
    [hw - 0.12, ys],
    [hw * 0.6, ys + (yc - ys) * 0.55],
    [hw * 0.3, ys + (yc - ys) * 0.9],
    [0, yc],
  ];
}

/** Mezza sezione dell'abitacolo (lato +x), dalla base sulla carrozzeria al centro del tetto. */
function cabinHalf(z: number): P2[] {
  const [hw, ys] = bodyAt(z);
  const [hwT, yt] = cabinAt(z);
  const yb = ys - 0.005;
  const hwB = hw - 0.13;
  return [
    [hwB, yb],
    [Math.min(hwB, hwT + 0.02), Math.max(yb, yt - 0.07)],
    [Math.min(hwB, hwT - 0.06), Math.max(yb, yt - 0.01)],
    [hwT * 0.5, Math.max(yb, yt + 0.012)],
    [0, Math.max(yb, yt + 0.015)],
  ];
}

/** Sezione completa e simmetrica da mezza sezione: lato +x in salita, lato -x in discesa. */
function mirrorFull(half: P2[], shareEnds: boolean): P2[] {
  const left = half.map(([x, y]) => [-x, y] as P2).reverse();
  return shareEnds ? [...half, ...left.slice(1, -1)] : [...half, ...left.slice(1)];
}

/** Altezza di una polilinea (punti con x decrescente) alla coordinata x. */
function heightAt(pts: P2[], x: number): number {
  const ax = Math.abs(x);
  if (ax >= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    if (ax <= x0 && ax >= x1) return y0 + ((y1 - y0) * (ax - x0)) / (x1 - x0 || 1);
  }
  return pts[pts.length - 1][1];
}

// ----------------------------------------------------------------------------
// Geometria: loft, tappi, orientamento delle facce
// ----------------------------------------------------------------------------

function loft(sections: P2[][], zs: number[], closed: boolean): THREE.BufferGeometry {
  const n = sections[0].length, m = zs.length;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      pos.push(sections[i][j][0], sections[i][j][1], zs[i]);
      uv.push(j / (n - 1), i / (m - 1));
    }
  }
  const jmax = closed ? n : n - 1;
  for (let i = 0; i < m - 1; i++) {
    for (let j = 0; j < jmax; j++) {
      const a = i * n + j, b = i * n + ((j + 1) % n), c = (i + 1) * n + j, d = (i + 1) * n + ((j + 1) % n);
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Tappo piatto (a ventaglio) che chiude una sezione. */
function cap(ring: P2[], z: number): THREE.BufferGeometry {
  const cx = 0, cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const pos: number[] = [cx, cy, z], uv: number[] = [0.5, 0.5], idx: number[] = [];
  ring.forEach(([x, y]) => { pos.push(x, y, z); uv.push(0.5 + x, y); });
  for (let j = 0; j < ring.length; j++) idx.push(0, 1 + j, 1 + ((j + 1) % ring.length));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Gira le facce perché guardino "fuori". `outward(p)` dà la direzione esterna
 * attesa in un punto; se le normali in media puntano dall'altra parte, si invertono.
 */
function orient(g: THREE.BufferGeometry, outward: (x: number, y: number, z: number) => [number, number, number]): THREE.BufferGeometry {
  const p = g.getAttribute('position'), nrm = g.getAttribute('normal');
  let s = 0;
  for (let i = 0; i < p.count; i++) {
    const [ox, oy, oz] = outward(p.getX(i), p.getY(i), p.getZ(i));
    s += nrm.getX(i) * ox + nrm.getY(i) * oy + nrm.getZ(i) * oz;
  }
  if (s < 0) {
    const index = g.getIndex()!;
    const a = index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    index.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

const fromAxis = (x: number, y: number): [number, number, number] => [x, y - 0.55, 0];

/** Fascia che segue una superficie: per ogni z, i punti xs con altezza surf(z, x) + rialzo. */
function surfacePatch(z0: number, z1: number, xsAt: (z: number) => number[], surf: (z: number, x: number) => number, lift: number): THREE.BufferGeometry {
  const zs = zSamples(z0, z1, 0.04);
  const secs = zs.map((z) => xsAt(z).map((x) => [x, surf(z, x) + lift] as P2));
  return orient(loft(secs, zs, false), () => [0, 1, 0]);
}

// ----------------------------------------------------------------------------
// Materiali
// ----------------------------------------------------------------------------

function materials() {
  return {
    paint: new THREE.MeshPhysicalMaterial({
      name: 'paint', color: '#ffffff', metalness: 0.3, roughness: 0.36, clearcoat: 1, clearcoatRoughness: 0.07, envMapIntensity: 1.6,
    }),
    accent: new THREE.MeshPhysicalMaterial({
      name: 'accent', color: '#ffffff', metalness: 0.1, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.08,
      envMapIntensity: 1.4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    number: new THREE.MeshStandardMaterial({
      name: 'number', color: '#ffffff', roughness: 0.4, alphaTest: 0.5,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      name: 'glass', color: '#0b1118', metalness: 0.1, roughness: 0.04, transparent: true, opacity: 0.72,
      clearcoat: 1, envMapIntensity: 2.2,
    }),
    carbon: new THREE.MeshStandardMaterial({ name: 'carbon', color: '#17191d', roughness: 0.42, metalness: 0.25, envMapIntensity: 1.2 }),
    interior: new THREE.MeshStandardMaterial({ name: 'interior', color: '#16181b', roughness: 0.85, side: THREE.DoubleSide }),
    lampGlass: new THREE.MeshPhysicalMaterial({
      name: 'lampglass', color: '#141a22', roughness: 0.05, metalness: 0.6, clearcoat: 1, envMapIntensity: 2,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    head: new THREE.MeshStandardMaterial({
      name: 'headlight', color: '#ffffff', emissive: '#fff6e0', emissiveIntensity: 1.4, roughness: 0.2,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }),
    tail: new THREE.MeshStandardMaterial({ name: 'taillight', color: '#5a0604', emissive: '#ff1a0a', emissiveIntensity: 0.9, roughness: 0.15 }),
    tyre: new THREE.MeshStandardMaterial({ name: 'tyre', color: '#1b1b1d', roughness: 0.93, side: THREE.DoubleSide }),
    rim: new THREE.MeshStandardMaterial({ name: 'rim', color: '#2b2e33', roughness: 0.3, metalness: 0.85, envMapIntensity: 1.4, side: THREE.DoubleSide }),
    disc: new THREE.MeshStandardMaterial({ name: 'disc', color: '#6d6f73', roughness: 0.55, metalness: 0.7 }),
  };
}
type Mats = ReturnType<typeof materials>;

// ----------------------------------------------------------------------------
// Costruzione
// ----------------------------------------------------------------------------

export function buildPlaceholderCar(car: CarParams): THREE.Group {
  const g = new THREE.Group();
  g.name = 'placeholder_gt';
  const M = materials();
  const L = car.wheelbase, r = car.wheelRadius;
  const axles = [L / 2, -L / 2];
  const RA = r + 0.09; // raggio del passaruota

  const parts = new THREE.Group();
  const put = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parts.add(m);
    return m;
  };

  // ---- Carrozzeria ----
  const archAt = (z: number) => {
    let y = -Infinity;
    for (const za of axles) {
      const dz = z - za;
      if (Math.abs(dz) < RA) y = Math.max(y, r + Math.sqrt(RA * RA - dz * dz));
    }
    return y;
  };
  const edges = axles.flatMap((za) => [za + RA + 0.002, za + RA - 0.002, za - RA + 0.002, za - RA - 0.002]);
  const zb = zSamples(Z_FRONT, Z_REAR, 0.025, edges);
  const bodySecs = zb.map((z) => mirrorFull(bodyHalf(z, archAt(z)), true));
  put(orient(loft(bodySecs, zb, true), fromAxis), M.paint);
  put(orient(cap(bodySecs[0], Z_FRONT), () => [0, 0, 1]), M.paint);
  put(orient(cap(bodySecs[bodySecs.length - 1], Z_REAR), () => [0, 0, -1]), M.paint);
  const topAt = (z: number, x: number) => heightAt(bodyHalf(z, -Infinity).slice(7), x);

  // passaruota scuri (si vedono dietro le ruote)
  for (const za of axles) {
    for (const s of [1, -1]) {
      const wellGeo = new THREE.CylinderGeometry(RA - 0.01, RA - 0.01, 0.36, 22, 1, true, 0, Math.PI);
      wellGeo.rotateZ(Math.PI / 2);
      put(wellGeo, M.interior, s * ((za > 0 ? car.trackFront : car.trackRear) / 2 + 0.01), r, za);
    }
  }

  // ---- Abitacolo: vetri, tetto, montanti ----
  const zc = zSamples(CAB_FRONT, CAB_REAR, 0.04);
  put(orient(loft(zc.map((z) => mirrorFull(cabinHalf(z), false)), zc, false), fromAxis), M.glass);
  const off = (pts: P2[]) => pts.map(([x, y]) => [x + Math.sign(x) * 0.006, y + 0.006] as P2);
  // tetto
  const zr = zSamples(0.18, -1.22, 0.04);
  const roofSecs = zr.map((z) => off(mirrorFull(cabinHalf(z).slice(1), false)));
  put(orient(loft(roofSecs, zr, false), fromAxis), M.paint);
  // montanti anteriori e posteriori (fiancate del lunotto)
  for (const s of [1, -1]) {
    const flip = (pts: P2[]) => pts.map(([x, y]) => [x * s, y] as P2);
    const za = zSamples(CAB_FRONT, 0.16, 0.04);
    put(orient(loft(za.map((z) => off(flip(cabinHalf(z).slice(1, 3)))), za, false), fromAxis), M.paint);
    const zp = zSamples(-1.0, CAB_REAR, 0.04);
    put(orient(loft(zp.map((z) => off(flip(cabinHalf(z).slice(0, 2)))), zp, false), fromAxis), M.paint);
  }

  // ---- Strisce (livrea) su cofano, tetto e coda ----
  for (const s of [1, -1]) {
    const xs = () => [0.05, 0.11, 0.17].map((x) => x * s);
    put(surfacePatch(2.29, 0.84, xs, topAt, 0.004), M.accent);
    put(surfacePatch(0.16, -1.2, xs, (z, x) => heightAt(off(cabinHalf(z).slice(1)), x), 0.003), M.accent);
    put(surfacePatch(-1.95, -2.25, xs, topAt, 0.004), M.accent);
  }

  // ---- Numeri di gara: portiere e tetto ----
  const numGeo = new THREE.PlaneGeometry(0.4, 0.4);
  const zDoor = -0.3;
  const [hwDoor, , , ybDoor] = bodyAt(zDoor);
  const ysDoor = bodyAt(zDoor)[1];
  put(numGeo, M.number, hwDoor + 0.004, ybDoor + (ysDoor - ybDoor) * 0.45, zDoor, 0, Math.PI / 2, 0);
  put(numGeo, M.number, -hwDoor - 0.004, ybDoor + (ysDoor - ybDoor) * 0.45, zDoor, 0, -Math.PI / 2, 0);
  const roofY = cabinAt(-0.55)[1] + 0.015 + 0.006 + 0.004;
  put(new THREE.PlaneGeometry(0.36, 0.36), M.number, 0, roofY, -0.55, -Math.PI / 2, 0, Math.PI);

  // ---- Fari anteriori (seguono la superficie del muso): vetro scuro + strisce LED ----
  const lampX = (z: number, inset: number) => {
    const t = (z - 1.98) / 0.28;
    return [0.5 - t * 0.1 + inset, 0.86 - t * 0.17 - inset];
  };
  for (const s of [1, -1]) {
    put(surfacePatch(2.26, 1.98, (z) => {
      const [x0, x1] = lampX(z, 0);
      return [x0, (x0 + x1) / 2, x1].map((x) => x * s);
    }, topAt, 0.005), M.lampGlass);
    for (const [za, zb2] of [[2.2, 2.16], [2.09, 2.04]]) {
      put(surfacePatch(za, zb2, (z) => {
        const [x0, x1] = lampX(z, 0.035);
        return [x0, x1].map((x) => x * s);
      }, topAt, 0.009), M.head);
    }
  }
  // fanali posteriori
  for (const s of [1, -1]) put(new THREE.BoxGeometry(0.42, 0.06, 0.02), M.tail, s * 0.56, 0.75, Z_REAR - 0.004);
  put(new THREE.BoxGeometry(0.62, 0.02, 0.02), M.tail, 0, 0.77, Z_REAR - 0.004);

  // ---- Aerodinamica e dettagli in carbonio ----
  put(new THREE.BoxGeometry(0.92, 0.11, 0.03), M.carbon, 0, 0.275, Z_FRONT); // presa d'aria centrale
  for (const s of [1, -1]) put(new THREE.BoxGeometry(0.2, 0.08, 0.03), M.carbon, s * 0.55, 0.26, Z_FRONT - 0.01);
  put(new THREE.BoxGeometry(1.88, 0.025, 0.32), M.carbon, 0, 0.11, Z_FRONT - 0.02); // splitter
  for (const s of [1, -1]) {
    // canard, minigonne, prese sul cofano
    put(new THREE.BoxGeometry(0.16, 0.012, 0.12), M.carbon, s * 0.9, 0.36, 2.12, 0, s * 0.35, s * 0.12);
    put(new THREE.BoxGeometry(0.07, 0.08, 2 * (L / 2 - RA) - 0.04), M.carbon, s * (bodyAt(0)[0] + 0.01), 0.15, 0);
    const zv = 1.78, xv = 0.3;
    put(new THREE.BoxGeometry(0.26, 0.012, 0.15), M.carbon, s * xv, topAt(zv, xv) + 0.004, zv, 0.12, 0, 0);
  }
  // diffusore con pinne
  put(new THREE.BoxGeometry(1.36, 0.08, 0.3), M.carbon, 0, 0.17, Z_REAR + 0.1);
  for (const x of [-0.45, -0.15, 0.15, 0.45]) put(new THREE.BoxGeometry(0.015, 0.14, 0.32), M.carbon, x, 0.2, Z_REAR + 0.06);
  // scarichi
  for (const s of [1, -1]) {
    const ex = new THREE.CylinderGeometry(0.048, 0.052, 0.14, 16, 1, true);
    ex.rotateX(Math.PI / 2);
    put(ex, M.rim, s * 0.74, 0.27, Z_REAR - 0.02);
  }
  // specchietti
  for (const s of [1, -1]) {
    const zm = 0.52;
    const xm = bodyAt(zm)[0] - 0.08;
    put(new THREE.BoxGeometry(0.11, 0.025, 0.04), M.carbon, s * xm, bodyAt(zm)[1] + 0.07, zm);
    put(new THREE.BoxGeometry(0.17, 0.09, 0.13), M.paint, s * (xm + 0.1), bodyAt(zm)[1] + 0.1, zm - 0.02);
  }

  // ala posteriore: profilo alare estruso + paratie + supporti "a collo di cigno"
  const chord = 0.34, span = 1.84;
  const foil = new THREE.Shape();
  const N = 14;
  const upper: P2[] = [], lower: P2[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (1 - Math.cos((i / N) * Math.PI)) / 2;
    const th = 5 * 0.13 * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4);
    const camber = -0.06 * Math.sin(Math.PI * t); // curvo verso il basso: spinge giù
    upper.push([t * chord, (camber + th) * chord]);
    lower.push([t * chord, (camber - th) * chord]);
  }
  foil.moveTo(...upper[0]);
  upper.slice(1).forEach((p) => foil.lineTo(...p));
  lower.reverse().slice(1).forEach((p) => foil.lineTo(...p));
  const wing = new THREE.ExtrudeGeometry(foil, { depth: span, bevelEnabled: false, curveSegments: 1 });
  wing.rotateY(Math.PI / 2); // corda lungo -z, apertura lungo x
  wing.translate(-span / 2, 0, 0);
  wing.rotateX(0.13); // incidenza
  put(wing, M.carbon, 0, 1.2, -1.9);
  for (const s of [1, -1]) {
    put(new THREE.BoxGeometry(0.02, 0.26, 0.46), M.carbon, s * (span / 2 + 0.01), 1.17, -2.06);
    put(new THREE.BoxGeometry(0.025, 0.34, 0.15), M.carbon, s * 0.42, 1.05, -1.99, 0.18, 0, 0);
  }

  // ---- Interni: pianale scuro, cruscotto, sedile, roll-bar ----
  const zi = zSamples(CAB_FRONT - 0.02, CAB_REAR + 0.02, 0.06);
  put(orient(loft(zi.map((z) => {
    const hwB = bodyAt(z)[0] - 0.14, y = bodyAt(z)[1] + 0.004;
    return [[hwB, y], [-hwB, y]] as P2[];
  }), zi, false), () => [0, 1, 0]), M.interior);
  put(new THREE.BoxGeometry(1.5, 0.1, 0.3), M.interior, 0, 0.92, 0.47); // cruscotto
  put(new THREE.BoxGeometry(0.46, 0.3, 0.09), M.interior, 0.38, 1.03, -0.84, -0.15, 0, 0); // schienale
  put(new THREE.BoxGeometry(0.48, 0.12, 0.45), M.interior, 0.38, 0.92, -0.6); // seduta
  const hoop = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.66, 0.88, -1.0), new THREE.Vector3(-0.6, 1.1, -1.0),
    new THREE.Vector3(0.6, 1.1, -1.0), new THREE.Vector3(0.66, 0.88, -1.0),
  ], false, 'catmullrom', 0.2), 16, 0.022, 6);
  put(hoop, M.interior);
  for (const s of [1, -1]) {
    put(new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(s * 0.6, 1.1, -1.0), new THREE.Vector3(s * 0.62, 0.88, 0.62)), 1, 0.02, 6), M.interior);
  }

  // ---- Fusione dei pezzi fissi: una mesh per materiale ----
  // solo carrozzeria, carbonio e interni proiettano ombra (il resto sta sopra o dentro)
  const shadowMats = new Set<THREE.Material>([M.paint, M.carbon, M.interior]);
  for (const m of mergeByMaterial(parts)) {
    m.name = 'body_' + (m.material as THREE.Material).name;
    if (!shadowMats.has(m.material as THREE.Material)) m.userData.noShadow = true;
    g.add(m);
  }

  // ---- Ruote ----
  const wheelLeft = buildWheel(r, 1, M), wheelRight = buildWheel(r, -1, M);
  const wheelDefs: [string, number, number][] = [
    ['wheel_FL', car.trackFront / 2, L / 2],
    ['wheel_FR', -car.trackFront / 2, L / 2],
    ['wheel_RL', car.trackRear / 2, -L / 2],
    ['wheel_RR', -car.trackRear / 2, -L / 2],
  ];
  for (const [name, x, z] of wheelDefs) {
    const w = (x > 0 ? wheelLeft : wheelRight).clone();
    w.name = name;
    w.position.set(x, r, z);
    g.add(w);
  }

  // ---- Volante (guida a sinistra = +X) ----
  const sw = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.02, 8, 28), M.interior);
  sw.name = 'steering_wheel';
  // piantone inclinato verso il pilota: il volante gira attorno al proprio asse
  const column = new THREE.Group();
  column.position.set(0.38, 0.9, 0.2);
  column.rotation.x = -0.25;
  sw.add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.035, 0.02), M.carbon));
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 0.025), M.head);
  top.position.y = 0.15;
  sw.add(top); // tacca gialla al centro: si vede quanto è girato
  column.add(sw);
  g.add(column);

  // ---- Punti telecamera ----
  const cockpit = new THREE.Object3D();
  cockpit.name = 'cam_cockpit';
  cockpit.position.set(0.38, 1.1, -0.55);
  const hood = new THREE.Object3D();
  hood.name = 'cam_hood';
  hood.position.set(0, 1.0, 0.95);
  g.add(cockpit, hood);
  return g;
}

/** Ruota completa; `outer` = +1 se la faccia esterna guarda verso +x. Asse di rotazione = X. */
function buildWheel(r: number, outer: number, M: Mats): THREE.Group {
  const w = new THREE.Group();
  const width = 0.3;
  const toX = (geo: THREE.BufferGeometry) => geo.rotateZ(Math.PI / 2);

  // pneumatico: profilo arrotondato fatto ruotare attorno all'asse
  const hw = width / 2;
  const prof = [
    [0.66, -hw + 0.005], [0.86, -hw], [0.95, -hw + 0.008], [0.99, -hw + 0.03], [1, -hw + 0.06],
    [1, hw - 0.06], [0.99, hw - 0.03], [0.95, hw - 0.008], [0.86, hw], [0.66, hw - 0.005],
  ].map(([k, a]) => new THREE.Vector2(k * r, a));
  const tyre = new THREE.LatheGeometry(prof, 40);
  w.add(new THREE.Mesh(toX(tyre), M.tyre));

  // canale del cerchio + bordo
  const rr = 0.66 * r;
  w.add(new THREE.Mesh(toX(new THREE.CylinderGeometry(rr, rr, width - 0.02, 28, 1, true)), M.rim));
  const lip = new THREE.TorusGeometry(rr, 0.012, 6, 32);
  lip.rotateY(Math.PI / 2);
  lip.translate(outer * (hw - 0.02), 0, 0);
  w.add(new THREE.Mesh(lip, M.rim));

  // disco freno (dietro alle razze)
  const disc = toX(new THREE.CylinderGeometry(0.55 * r, 0.55 * r, 0.03, 28));
  disc.translate(-outer * 0.02, 0, 0);
  w.add(new THREE.Mesh(disc, M.disc));

  // 10 razze (5 doppie) e mozzo con dado centrale
  const spokes: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 10; k++) {
    const sp = new THREE.BoxGeometry(0.03, rr - 0.05, 0.035);
    sp.translate(0, (rr - 0.05) / 2 + 0.04, 0);
    sp.rotateZ(0); // (la razza è già radiale lungo y)
    sp.rotateX((k * Math.PI) / 5 + (k % 2 ? 0.12 : -0.12));
    sp.translate(outer * (hw - 0.05), 0, 0);
    spokes.push(sp);
  }
  w.add(new THREE.Mesh(mergeGeometries(spokes.map((s) => s.toNonIndexed())), M.rim));
  const hub = toX(new THREE.CylinderGeometry(0.075, 0.085, 0.06, 16));
  hub.translate(outer * (hw - 0.04), 0, 0);
  w.add(new THREE.Mesh(hub, M.rim));
  const nut = toX(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 6));
  nut.translate(outer * (hw - 0.01), 0, 0);
  w.add(new THREE.Mesh(nut, M.rim));

  const merged = new THREE.Group();
  for (const m of mergeByMaterial(w)) {
    if (m.material !== M.tyre) m.userData.noShadow = true;
    merged.add(m);
  }
  return merged;
}

/** Fonde tutte le mesh discendenti di `group` in una mesh per materiale (trasformazioni incluse). */
function mergeByMaterial(group: THREE.Object3D): THREE.Mesh[] {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    let geo = mesh.geometry.clone();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
    if (geo.index) geo = geo.toNonIndexed();
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    geo.clearGroups();
    const mat = mesh.material as THREE.Material;
    if (!buckets.has(mat)) buckets.set(mat, []);
    buckets.get(mat)!.push(geo);
  });
  return [...buckets].map(([mat, geos]) => new THREE.Mesh(mergeGeometries(geos), mat));
}

// ----------------------------------------------------------------------------
// Livrea: colore, strisce a contrasto e numero di gara
// ----------------------------------------------------------------------------

const numberTextures = new Map<number, THREE.Texture>();

/** Tondo bianco con il numero di gara (texture disegnata su un canvas). */
export function numberTexture(n: number): THREE.Texture {
  let t = numberTextures.get(n);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(128, 128, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#111111';
  ctx.stroke();
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 150px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), 128, 138);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  numberTextures.set(n, t);
  return t;
}

/** Colore delle strisce: scuro sulle auto chiare, bianco sulle auto scure. */
export function accentFor(paint: THREE.Color): THREE.Color {
  const lum = 0.2126 * paint.r + 0.7152 * paint.g + 0.0722 * paint.b; // (spazio lineare)
  return new THREE.Color(lum > 0.3 ? '#16181c' : '#f1f1f1');
}
