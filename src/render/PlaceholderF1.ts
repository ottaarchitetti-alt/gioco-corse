/**
 * MONOPOSTO 2026 segnaposto, costruita via codice (finché non metti il tuo GLB).
 *
 * Pezzi: muso e scocca (loft di sezioni arrotondate), abitacolo con casco del
 * pilota e halo, pance laterali con prese d'aria, cofano motore con presa
 * dell'airbox e pinna, fondo piatto con diffusore, ala anteriore a 3 elementi,
 * ala posteriore con flap mobile, sospensioni a triangoli, ruote scoperte
 * (posteriori più larghe) con la fascia colorata della mescola sul fianco.
 *
 * Nomi in comune con un GLB fatto in Blender (vedi public/models/LEGGIMI.md):
 *  - `wheel_FL/FR/RL/RR`, `steering_wheel`, `cam_cockpit`, `cam_hood` (qui: T-cam sul roll-bar)
 *  - materiali `paint`, `accent`, `number`, `tyrestripe` (colore della mescola)
 *  - `aero_front_flap`, `aero_rear_flap`: si aprono con l'aerodinamica attiva
 */
import * as THREE from 'three';
import type { CarParams } from '../physics/CarParams';
import {
  cap, loft, materials, mergeByMaterial, orient, profile, surfacePatch, zSamples, type Mats, type P2,
} from './PlaceholderCar';

/** Sezione arrotondata ("superellisse"): centro x, semilarghezza, fondo, cima, esponente. */
function roundSection(cx: number, hw: number, yb: number, yt: number, n = 3.2, count = 28): P2[] {
  const yc = (yb + yt) / 2, hh = (yt - yb) / 2;
  const pts: P2[] = [];
  for (let k = 0; k < count; k++) {
    const a = -Math.PI / 2 + (k / count) * Math.PI * 2; // parte dal fondo, sale sul lato +x
    const c = Math.cos(a), s = Math.sin(a);
    pts.push([cx + hw * Math.sign(c) * Math.abs(c) ** (2 / n), yc + hh * Math.sign(s) * Math.abs(s) ** (2 / n)]);
  }
  return pts;
}
/** Altezza della cima di una superellisse alla coordinata x. */
function roundTop(hw: number, yb: number, yt: number, x: number, n = 3.2): number {
  const yc = (yb + yt) / 2, hh = (yt - yb) / 2;
  const u = Math.min(1, Math.abs(x) / hw);
  return yc + hh * Math.pow(Math.max(0, 1 - u ** n), 1 / n);
}

/** Muso + scocca + cofano motore: z, semilarghezza, fondo, cima */
const CHASSIS: number[][] = [
  [2.7, 0.06, 0.2, 0.29],
  [2.45, 0.11, 0.18, 0.35],
  [2.05, 0.16, 0.16, 0.43],
  [1.6, 0.22, 0.14, 0.52],
  [1.1, 0.28, 0.1, 0.6],
  [0.7, 0.35, 0.08, 0.65],
  [0.3, 0.4, 0.08, 0.62],
  [-0.25, 0.42, 0.08, 0.63],
  [-0.55, 0.38, 0.08, 0.84],
  [-0.85, 0.3, 0.09, 0.96],
  [-1.2, 0.27, 0.1, 0.83],
  [-1.7, 0.22, 0.12, 0.62],
  [-2.1, 0.14, 0.16, 0.46],
  [-2.32, 0.08, 0.2, 0.36],
];
const CH_FRONT = 2.7, CH_REAR = -2.32;
const chassisAt = profile(CHASSIS);

/** Pance: z, bordo interno, bordo esterno, fondo, cima */
const PODS: number[][] = [
  [0.6, 0.36, 0.8, 0.1, 0.5],
  [0.25, 0.36, 0.83, 0.1, 0.54],
  [-0.3, 0.36, 0.78, 0.1, 0.5],
  [-0.8, 0.32, 0.62, 0.1, 0.4],
  [-1.3, 0.26, 0.42, 0.1, 0.3],
  [-1.62, 0.22, 0.3, 0.1, 0.22],
];
const POD_FRONT = 0.6, POD_REAR = -1.62;
const podAt = profile(PODS);

/** Profilo alare (NACA a 4 cifre semplificato), corda lungo -z a partire da 0. */
function airfoil(chord: number, thick: number, camber: number, span: number, segs = 12): THREE.BufferGeometry {
  const up: P2[] = [], lo: P2[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = (1 - Math.cos((i / segs) * Math.PI)) / 2;
    const th = 5 * thick * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4);
    const cam = camber * Math.sin(Math.PI * t);
    up.push([t * chord, (cam + th) * chord]);
    lo.push([t * chord, (cam - th) * chord]);
  }
  const sh = new THREE.Shape();
  sh.moveTo(...up[0]);
  up.slice(1).forEach((p) => sh.lineTo(...p));
  lo.reverse().slice(1).forEach((p) => sh.lineTo(...p));
  const g = new THREE.ExtrudeGeometry(sh, { depth: span, bevelEnabled: false, curveSegments: 1 });
  g.rotateY(Math.PI / 2);
  g.translate(-span / 2, 0, 0);
  return g;
}

function tube(points: [number, number, number][], radius: number, closed = false): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed, 'catmullrom', 0.3);
  return new THREE.TubeGeometry(curve, Math.max(4, points.length * 6), radius, 8, closed);
}
const rod = (a: [number, number, number], b: [number, number, number], r: number) =>
  new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(...a), new THREE.Vector3(...b)), 1, r, 6);

export function buildPlaceholderF1(car: CarParams): THREE.Group {
  const g = new THREE.Group();
  g.name = 'placeholder_monoposto';
  const M = materials();
  const stripe = new THREE.MeshStandardMaterial({ name: 'tyrestripe', color: '#f6d21e', roughness: 0.6, side: THREE.DoubleSide });
  const L = car.wheelbase, r = car.wheelRadius;
  const zf = L / 2, zr = -L / 2;
  const parts = new THREE.Group();
  const put = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parts.add(m);
    return m;
  };

  // ---- Scocca, muso e cofano motore ----
  const zc = zSamples(CH_FRONT, CH_REAR, 0.04);
  const secs = zc.map((z) => { const [hw, yb, yt] = chassisAt(z); return roundSection(0, hw, yb, yt); });
  const outward = (x: number, y: number): [number, number, number] => [x, y - 0.4, 0];
  put(orient(loft(secs, zc, true), outward), M.paint);
  put(orient(cap(secs[0], CH_FRONT), () => [0, 0, 1]), M.paint);
  put(orient(cap(secs[secs.length - 1], CH_REAR), () => [0, 0, -1]), M.carbon);
  const chTop = (z: number, x: number) => { const [hw, yb, yt] = chassisAt(z); return roundTop(hw, yb, yt, x); };

  // striscia della livrea sul muso e sul cofano
  const xsStripe = () => [-0.05, 0, 0.05];
  put(surfacePatch(2.6, 0.75, xsStripe, chTop, 0.003), M.accent);
  put(surfacePatch(-0.95, -2.25, xsStripe, chTop, 0.003), M.accent);

  // apertura dell'abitacolo (ellisse scura) e casco del pilota
  put(surfacePatch(0.62, -0.38, (z) => {
    const t = (z - 0.12) / 0.5;
    const w = 0.27 * Math.sqrt(Math.max(0.02, 1 - t * t));
    return [-w, -w / 2, 0, w / 2, w];
  }, chTop, 0.004), M.interior);
  const helmet = new THREE.SphereGeometry(0.15, 20, 14);
  put(helmet, M.accent, 0, 0.76, -0.13);
  put(new THREE.SphereGeometry(0.152, 20, 6, -Math.PI * 0.32, Math.PI * 0.64, Math.PI * 0.38, Math.PI * 0.16), M.glass, 0, 0.76, -0.13); // visiera
  put(new THREE.BoxGeometry(0.34, 0.12, 0.3), M.interior, 0, 0.66, -0.3); // poggiatesta

  // presa d'aria dell'airbox sopra la testa
  put(new THREE.CylinderGeometry(0.1, 0.11, 0.06, 18).rotateX(Math.PI / 2), M.interior, 0, 0.9, -0.6);

  // pinna sul cofano
  const fin = new THREE.Shape();
  fin.moveTo(-0.95, 0.9); fin.lineTo(-2.0, 0.72); fin.lineTo(-2.0, 0.5); fin.lineTo(-1.4, 0.62); fin.lineTo(-0.95, 0.8);
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.012, bevelEnabled: false });
  finGeo.rotateY(-Math.PI / 2);
  finGeo.translate(0.006, 0, 0);
  put(finGeo, M.paint);

  // ---- Halo (protezione del pilota) ----
  put(tube([[-0.27, 0.62, -0.34], [-0.27, 0.8, -0.24], [-0.25, 0.86, 0.0], [0, 0.88, 0.24], [0.25, 0.86, 0.0], [0.27, 0.8, -0.24], [0.27, 0.62, -0.34]], 0.024), M.carbon);
  put(rod([0, 0.62, 0.46], [0, 0.88, 0.25], 0.026), M.carbon);

  // ---- Pance laterali ----
  for (const sgn of [1, -1]) {
    const zp = zSamples(POD_FRONT, POD_REAR, 0.05);
    const ps = zp.map((z) => {
      const [xi, xo, yb, yt] = podAt(z);
      return roundSection(sgn * (xi + xo) / 2, (xo - xi) / 2, yb, yt, 3.5).map(([x, y]) => [x, y] as P2);
    });
    put(orient(loft(ps, zp, true), (x, y) => [x - sgn * 0.55, y - 0.3, 0]), M.paint);
    // bocca della presa d'aria (scura) e tappo posteriore
    put(orient(cap(ps[0], POD_FRONT + 0.002), () => [0, 0, 1]), M.interior);
    put(orient(cap(ps[ps.length - 1], POD_REAR), () => [0, 0, -1]), M.paint);
    // specchietto
    put(new THREE.BoxGeometry(0.15, 0.06, 0.05), M.paint, sgn * 0.6, 0.7, 0.42);
    put(rod([sgn * 0.45, 0.55, 0.42], [sgn * 0.56, 0.69, 0.42], 0.01), M.carbon);
  }

  // ---- Fondo piatto e diffusore ----
  const floor = new THREE.Shape();
  floor.moveTo(-0.3, 1.2); floor.lineTo(0.3, 1.2); floor.lineTo(0.84, 0.55); floor.lineTo(0.84, -1.2);
  floor.lineTo(0.5, -1.45); floor.lineTo(0.5, -2.05); floor.lineTo(-0.5, -2.05); floor.lineTo(-0.5, -1.45);
  floor.lineTo(-0.84, -1.2); floor.lineTo(-0.84, 0.55); floor.closePath();
  const floorGeo = new THREE.ExtrudeGeometry(floor, { depth: 0.025, bevelEnabled: false });
  floorGeo.rotateX(Math.PI / 2); // la forma è disegnata in (x, z): la y della forma diventa la z
  put(floorGeo, M.carbon, 0, 0.06, 0);
  for (const x of [-0.3, 0, 0.3]) put(new THREE.BoxGeometry(0.012, 0.18, 0.5), M.carbon, x, 0.14, -1.85, 0.32, 0, 0);
  put(new THREE.BoxGeometry(1.0, 0.02, 0.55), M.carbon, 0, 0.17, -1.9, 0.32, 0, 0); // rampa del diffusore

  // ---- Ala anteriore: piano principale fisso + flap mobili ----
  const fwSpan = 1.76;
  put(airfoil(0.3, 0.1, 0.07, fwSpan), M.carbon, 0, 0.09, 2.78, -0.06, 0, 0);
  const fFlap = new THREE.Group();
  fFlap.name = 'aero_front_flap';
  fFlap.position.set(0, 0.13, 2.5); // perno sul bordo d'attacco
  for (const [dy, dz, ch] of [[0, 0, 0.16], [0.05, -0.12, 0.12]] as [number, number, number][]) {
    const f = new THREE.Mesh(airfoil(ch, 0.09, 0.06, fwSpan - 0.1), M.paint);
    f.position.set(0, dy, dz);
    f.rotation.x = 0.35 + dy * 4;
    fFlap.add(f);
  }
  for (const sgn of [1, -1]) {
    put(new THREE.BoxGeometry(0.02, 0.26, 0.52), M.carbon, sgn * (fwSpan / 2 + 0.01), 0.18, 2.5);
    put(new THREE.BoxGeometry(0.02, 0.14, 0.3), M.carbon, sgn * 0.12, 0.17, 2.55); // piloni del muso
  }

  // ---- Ala posteriore: piano principale + flap mobile, paratie, pilone ----
  const rwSpan = 1.0;
  put(airfoil(0.26, 0.12, 0.08, rwSpan), M.carbon, 0, 0.8, -2.02, -0.1, 0, 0);
  const rFlap = new THREE.Group();
  rFlap.name = 'aero_rear_flap';
  rFlap.position.set(0, 0.9, -2.0);
  const rf = new THREE.Mesh(airfoil(0.17, 0.1, 0.06, rwSpan - 0.02), M.paint);
  rf.rotation.x = 0.5; // flap chiuso (molto carico); in modalità rettilineo si appiattisce
  rFlap.add(rf);
  for (const sgn of [1, -1]) put(new THREE.BoxGeometry(0.02, 0.48, 0.5), M.paint, sgn * (rwSpan / 2 + 0.01), 0.78, -2.12);
  put(new THREE.BoxGeometry(0.03, 0.42, 0.12), M.carbon, 0, 0.6, -2.16); // pilone
  put(airfoil(0.16, 0.12, 0.05, 0.9), M.carbon, 0, 0.4, -2.08, -0.15, 0, 0); // beam wing

  // ---- Sospensioni (triangoli, puntoni) ----
  const susp = (z: number, track: number, chassisX: number, front: boolean) => {
    for (const sgn of [1, -1]) {
      const wx = sgn * (track / 2 - (front ? 0.12 : 0.16));
      const cx = sgn * chassisX;
      for (const [yc, yw] of [[0.42, 0.5], [0.22, 0.2]] as [number, number][]) {
        put(rod([cx, yc, z + 0.22], [wx, yw, z], 0.014), M.carbon);
        put(rod([cx, yc, z - 0.22], [wx, yw, z], 0.014), M.carbon);
      }
      put(rod([cx, 0.5, z + 0.05], [wx, 0.24, z + 0.02], 0.012), M.carbon); // puntone
    }
  };
  susp(zf, car.trackFront, 0.18, true);
  susp(zr, car.trackRear, 0.14, false);

  // ---- Numeri di gara: muso e fianchi del cofano ----
  const nGeo = new THREE.PlaneGeometry(0.2, 0.2);
  const zN = 2.15;
  put(nGeo, M.number, 0, chTop(zN, 0) + 0.006, zN, -Math.PI / 2 + 0.22, 0, Math.PI);
  for (const sgn of [1, -1]) {
    const zS = -1.15;
    const [hw] = chassisAt(zS);
    put(new THREE.PlaneGeometry(0.26, 0.26), M.number, sgn * (hw + 0.006), 0.6, zS, 0, sgn * Math.PI / 2, 0);
  }

  // ---- Fusione: una mesh per materiale ----
  const shadow = new Set<THREE.Material>([M.paint, M.carbon, M.accent]);
  for (const m of mergeByMaterial(parts)) {
    m.name = 'body_' + (m.material as THREE.Material).name;
    if (!shadow.has(m.material as THREE.Material)) m.userData.noShadow = true;
    g.add(m);
  }
  // i flap restano separati: si muovono
  for (const flap of [fFlap, rFlap]) {
    const merged = new THREE.Group();
    merged.name = flap.name;
    merged.position.copy(flap.position);
    flap.position.set(0, 0, 0);
    for (const m of mergeByMaterial(flap)) merged.add(m);
    g.add(merged);
  }

  // ---- Ruote (posteriori più larghe) ----
  const wheels: [string, number, number, number][] = [
    ['wheel_FL', car.trackFront / 2, zf, 0.3],
    ['wheel_FR', -car.trackFront / 2, zf, 0.3],
    ['wheel_RL', car.trackRear / 2, zr, 0.38],
    ['wheel_RR', -car.trackRear / 2, zr, 0.38],
  ];
  const cache = new Map<string, THREE.Group>();
  for (const [name, x, z, w] of wheels) {
    const key = `${x > 0 ? 1 : -1}_${w}`;
    if (!cache.has(key)) cache.set(key, buildOpenWheel(r, w, x > 0 ? 1 : -1, M, stripe));
    const wheel = cache.get(key)!.clone();
    wheel.name = name;
    wheel.position.set(x, r, z);
    g.add(wheel);
  }

  // ---- Volante (piccolo, rettangolare) ----
  const column = new THREE.Group();
  column.position.set(0, 0.56, 0.4);
  column.rotation.x = -0.5;
  const sw = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.13, 0.03), M.carbon);
  sw.name = 'steering_wheel';
  for (const sgn of [1, -1]) {
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.15, 0.05), M.interior);
    grip.position.x = sgn * 0.14;
    sw.add(grip);
  }
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.05), M.head);
  screen.position.set(0, 0.01, -0.017);
  screen.rotation.y = Math.PI;
  sw.add(screen);
  column.add(sw);
  g.add(column);

  // ---- Punti telecamera: occhi del pilota e T-cam sul roll-bar ----
  const cockpit = new THREE.Object3D();
  cockpit.name = 'cam_cockpit';
  cockpit.position.set(0, 0.745, 0.0);
  const tcam = new THREE.Object3D();
  tcam.name = 'cam_hood';
  tcam.position.set(0, 1.1, -0.72);
  g.add(cockpit, tcam);
  return g;
}

/** Ruota scoperta: gomma larga, cerchio scuro, disco freno, fascia colorata della mescola. */
function buildOpenWheel(r: number, width: number, outer: number, M: Mats, stripe: THREE.Material): THREE.Group {
  const w = new THREE.Group();
  const hw = width / 2;
  const toX = (geo: THREE.BufferGeometry) => geo.rotateZ(Math.PI / 2);
  const prof = [
    [0.64, -hw + 0.006], [0.86, -hw], [0.95, -hw + 0.01], [0.99, -hw + 0.035], [1, -hw + 0.07],
    [1, hw - 0.07], [0.99, hw - 0.035], [0.95, hw - 0.01], [0.86, hw], [0.64, hw - 0.006],
  ].map(([k, a]) => new THREE.Vector2(k * r, a));
  w.add(new THREE.Mesh(toX(new THREE.LatheGeometry(prof, 40)), M.tyre));
  // fascia della mescola sul fianco esterno
  const ring = new THREE.RingGeometry(0.74 * r, 0.8 * r, 40);
  ring.rotateY(outer > 0 ? Math.PI / 2 : -Math.PI / 2);
  ring.translate(outer * (hw + 0.002), 0, 0);
  w.add(new THREE.Mesh(ring, stripe));
  // cerchio: canale, copricerchio scuro, mozzo
  const rr = 0.64 * r;
  w.add(new THREE.Mesh(toX(new THREE.CylinderGeometry(rr, rr, width - 0.02, 28, 1, true)), M.rim));
  const cover = toX(new THREE.CylinderGeometry(rr, rr, 0.01, 28));
  cover.translate(outer * (hw - 0.03), 0, 0);
  w.add(new THREE.Mesh(cover, M.rim));
  const spokes: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 6; k++) {
    const sp = new THREE.BoxGeometry(0.012, rr * 0.9, 0.03);
    sp.translate(0, rr * 0.45, 0);
    sp.rotateX((k * Math.PI) / 3);
    sp.translate(outer * (hw - 0.022), 0, 0);
    spokes.push(sp.toNonIndexed());
  }
  for (const sp of spokes) w.add(new THREE.Mesh(sp, M.disc));
  const nut = toX(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 6));
  nut.translate(outer * (hw - 0.005), 0, 0);
  w.add(new THREE.Mesh(nut, M.disc));
  const merged = new THREE.Group();
  for (const m of mergeByMaterial(w)) {
    if (m.material !== M.tyre) m.userData.noShadow = true;
    merged.add(m);
  }
  return merged;
}
