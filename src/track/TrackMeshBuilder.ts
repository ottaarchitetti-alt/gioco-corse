/**
 * Converte una TrackSpline in oggetti 3D: asfalto, cordoli, prato,
 * linea di partenza, griglia, portale, corsia box con edifici, oggetti
 * di contorno e alberi.
 *
 * La pista NON si modella in Blender: viene generata da qui a partire dal
 * JSON dell'editor. In Blender si modellano solo gli elementi di contorno
 * (tribune, barriere, edifici), che si piazzano dall'editor (strumento Oggetti).
 */
import * as THREE from 'three';
import { asphaltTexture, checkerTexture, grassTexture, seededRandom } from '../render/textures';
import { buildProp } from './PropBuilder';
import { loadSettings, qualityParams } from '../ui/Settings';
import { PROP_CATALOG } from './props';
import { KERB_WIDTH, TrackSpline, type PitLaneSpline } from './TrackSpline';

// Piccole altezze per evitare che superfici sovrapposte "sfarfallino"
const Y_ROAD = 0.02;
const Y_PIT = 0.012; // sotto la pista: dove si sovrappongono (ingresso/uscita) vince la pista
const Y_KERB = 0.035;
const Y_LINE = 0.03;
/** Lunghezza (m) di una ripetizione della texture d'asfalto */
const ASPHALT_REPEAT = 10;

export function buildTrackMesh(track: TrackSpline, anisotropy: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'track';
  const asphalt = new THREE.MeshStandardMaterial({ map: asphaltTexture(anisotropy), roughness: 0.92, metalness: 0 });
  group.add(buildRoad(track, asphalt));
  group.add(buildKerbs(track));
  group.add(buildGround(anisotropy, track));
  group.add(buildStartLine(track));
  group.add(buildGridMarks(track));
  group.add(buildGantry(track));
  if (track.pit) group.add(buildPitLane(track.pit, asphalt));
  for (const p of track.data.props) group.add(buildProp(p));
  if (track.data.autoTrees) group.add(buildTrees(track));
  group.add(buildBrakeBoards(track));
  return group;
}

/**
 * Curve che richiedono una frenata: tratti con raggio < 130 m (curvatura media su ~20 m) che girano
 * di almeno 25°, preceduti da un rettilineo di almeno 140 m. Le chicane (curve a meno di 50 m l'una
 * dall'altra) contano come una curva sola. Restituisce per ogni curva l'ascissa d'ingresso, la
 * lunghezza del rettilineo prima e il lato verso cui gira (+1 sinistra, −1 destra).
 */
export function brakingCorners(track: TrackSpline): { s: number; approach: number; side: number }[] {
  const smp = track.samples;
  const n = smp.length;
  const step = track.length / n;
  const w = Math.max(1, Math.round(10 / step));
  const k = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = -w; j <= w; j++) sum += track.at(i + j).curvature;
    k[i] = sum / (2 * w + 1);
  }
  const isCorner = (i: number) => Math.abs(k[((i % n) + n) % n]) > 1 / 130;
  const isStraight = (i: number) => Math.abs(k[((i % n) + n) % n]) < 1 / 350;
  // si parte da un punto non in curva, così nessuna curva viene spezzata dal giro del contatore
  let start = 0;
  while (start < n && isCorner(start)) start++;
  if (start >= n) return [];
  const regions: { a: number; b: number; turn: number }[] = [];
  for (let c = 0; c < n; c++) {
    const i = start + c;
    if (!isCorner(i)) continue;
    let j = i, turn = 0;
    while (j - start < n && isCorner(j)) { turn += Math.abs(k[j % n]) * step; j++; }
    const last = regions[regions.length - 1];
    if (last && i - last.b < 50 / step) { last.b = j; last.turn += turn; } // chicane: stessa curva
    else regions.push({ a: i, b: j, turn });
    c = j - start;
  }
  const out: { s: number; approach: number; side: number }[] = [];
  for (const r of regions) {
    if (Math.abs(r.turn) < 25 * (Math.PI / 180)) continue;
    // rettilineo prima della curva (ignorando i primi metri di ingresso)
    let a = r.a - 1, len = 0;
    while (len < 400 && (isStraight(a) || !isCorner(a))) { len += step; a--; if (r.a - a > n - 2) break; }
    if (len < 140) continue;
    // lato: verso cui gira il primo tratto (in una chicane conta la prima curva)
    out.push({ s: (r.a % n) * step, approach: len, side: Math.sign(k[r.a % n]) || 1 });
  }
  return out;
}

/** Testo dei cartelli di frenata (canvas condivise per 100, 200, 300 m). */
function boardTexture(label: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f4';
  g.fillRect(0, 0, 256, 160);
  g.fillStyle = '#c8102e';
  g.fillRect(0, 0, 256, 18);
  g.fillRect(0, 142, 256, 18);
  g.fillStyle = '#111';
  g.font = 'bold 104px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 128, 84);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Cartelli di frenata 300/200/100/50/25 m prima delle curve, sul lato esterno del rettilineo
 * d'avvicinamento (come nei circuiti veri). Prima delle curve con rettilineo corto ci sono
 * solo i cartelli che ci stanno.
 */
function buildBrakeBoards(track: TrackSpline): THREE.Group {
  const g = new THREE.Group();
  g.name = 'brake_boards';
  const dists = [300, 200, 100, 50, 25];
  const faceMats = new Map(dists.map((d) => [d, new THREE.MeshStandardMaterial({ map: boardTexture(String(d)), roughness: 0.7 })]));
  const frameMat = new THREE.MeshStandardMaterial({ color: '#2a2d33', roughness: 0.6, metalness: 0.3 });
  const panelGeo = new THREE.PlaneGeometry(2.4, 1.5);
  const backGeo = new THREE.BoxGeometry(2.55, 1.65, 0.1);
  const postGeo = new THREE.BoxGeometry(0.12, 1.5, 0.12);
  const coarse = track.samples.filter((_, i) => i % 4 === 0);
  for (const corner of brakingCorners(track)) {
    for (const dist of dists) {
      if (dist > corner.approach - 15) continue;
      const smp = track.atS(corner.s - dist);
      // lato esterno: opposto alla direzione della curva
      const side = -corner.side;
      const off = smp.width / 2 + KERB_WIDTH + 2.8;
      const x = smp.x + smp.nx * off * side, z = smp.z + smp.nz * off * side;
      // niente cartelli sopra un altro tratto di pista (piste che si avvicinano a sé stesse)
      if (coarse.some((c) => c !== smp && Math.hypot(c.x - x, c.z - z) < c.width / 2 + 2.5)) continue;
      const b = new THREE.Group();
      const face = new THREE.Mesh(panelGeo, faceMats.get(dist)!);
      face.position.set(0, 2.25, -0.055);
      face.rotation.y = Math.PI; // guarda verso chi arriva
      const back = new THREE.Mesh(backGeo, frameMat);
      back.position.y = 2.25;
      back.castShadow = true;
      b.add(face, back);
      for (const px of [-0.9, 0.9]) {
        const post = new THREE.Mesh(postGeo, frameMat);
        post.position.set(px, 0.75, 0);
        post.castShadow = true;
        b.add(post);
      }
      b.position.set(x, 0, z);
      // un filo girato verso la pista, così si legge meglio
      b.rotation.y = smp.heading + side * 0.25;
      g.add(b);
    }
  }
  return g;
}

/** Una striscia piatta (es. linea bianca) centrata in (x,z), orientata con heading. */
function flatStrip(x: number, z: number, heading: number, across: number, along: number, mat: THREE.Material, y = Y_LINE) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(across, along), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  const h = new THREE.Group();
  h.add(m);
  h.position.set(x, 0, z);
  h.rotation.y = heading;
  m.receiveShadow = true;
  return h;
}

/** Piazzole della griglia: una linea bianca davanti a ogni posto. */
function buildGridMarks(track: TrackSpline): THREE.Group {
  const g = new THREE.Group();
  g.name = 'grid';
  const white = new THREE.MeshStandardMaterial({ color: '#f0f0f0', roughness: 0.8 });
  for (const s of track.grid) {
    // davanti all'auto (l'origine del posto è il centro dell'auto)
    const fx = Math.sin(s.heading) * 2.6, fz = Math.cos(s.heading) * 2.6;
    g.add(flatStrip(s.x + fx, s.z + fz, s.heading, 2.6, 0.25, white));
  }
  return g;
}

/** Corsia box: asfalto, linee del limitatore, piazzole e edifici dei box. */
function buildPitLane(pit: PitLaneSpline, asphalt: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.name = 'pit_lane';
  const hw = pit.data.width / 2;
  const n = pit.samples.length;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  pit.samples.forEach((s) => {
    pos.push(s.x + s.nx * hw, Y_PIT, s.z + s.nz * hw, s.x - s.nx * hw, Y_PIT, s.z - s.nz * hw);
    uv.push(0, s.s / ASPHALT_REPEAT, 1, s.s / ASPHALT_REPEAT);
  });
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const road = new THREE.Mesh(geo, asphalt);
  road.receiveShadow = true;
  g.add(road);

  // Linee del limitatore (bianco/blu) e piazzole (gialle)
  const white = new THREE.MeshStandardMaterial({ color: '#f0f0f0', roughness: 0.8 });
  const blue = new THREE.MeshStandardMaterial({ color: '#2a63d4', roughness: 0.8 });
  const yellow = new THREE.MeshStandardMaterial({ color: '#f2c230', roughness: 0.8 });
  for (const s of [pit.limiterStart, pit.limiterEnd]) {
    const p = pit.atS(s);
    g.add(flatStrip(p.x, p.z, p.heading, pit.data.width, 0.5, white, Y_PIT + 0.01));
    const q = pit.atS(s + 0.6);
    g.add(flatStrip(q.x, q.z, q.heading, pit.data.width, 0.5, blue, Y_PIT + 0.01));
  }
  for (const st of pit.stalls) g.add(flatStrip(st.x, st.z, st.heading, 2.4, 0.2, yellow, Y_PIT + 0.01));

  // Edifici dei box: un blocco per box, con la "serranda" scura verso la corsia
  const wall = new THREE.MeshStandardMaterial({ color: '#d9dde3', roughness: 0.7 });
  const door = new THREE.MeshStandardMaterial({ color: '#2b3038', roughness: 0.5 });
  const side = pit.data.garageSide === 'left' ? 1 : -1;
  const spacing = pit.garages.length > 1 ? Math.abs(pit.garages[1].s - pit.garages[0].s) : 12;
  for (const gar of pit.garages) {
    const b = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(spacing * 0.98, 6, 10), wall);
    body.position.y = 3;
    body.castShadow = body.receiveShadow = true;
    const d = new THREE.Mesh(new THREE.BoxGeometry(spacing * 0.75, 4, 0.1), door);
    // Con rotazione heading − 90°: X locale = avanti lungo la corsia, Z locale = verso DESTRA.
    // Box a sinistra (side = 1) → la corsia è alla sua destra (+Z); box a destra → −Z.
    d.position.set(0, 2, side * 5.02);
    b.add(body, d);
    b.position.set(gar.x, 0, gar.z);
    b.rotation.y = gar.heading - Math.PI / 2;
    g.add(b);
  }
  return g;
}

/** Nastro d'asfalto: due vertici per campione (bordo sinistro e destro). */
function buildRoad(track: TrackSpline, mat: THREE.Material): THREE.Mesh {
  const n = track.samples.length;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = track.at(i);
    const h = s.width / 2;
    pos.push(s.x + s.nx * h, Y_ROAD, s.z + s.nz * h);
    pos.push(s.x - s.nx * h, Y_ROAD, s.z - s.nz * h);
    const v = (i === n ? track.length : s.s) / ASPHALT_REPEAT;
    uv.push(0, v, 1, v);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c); // ordine antiorario visto dall'alto → normale verso +Y
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'road';
  mesh.receiveShadow = true;
  return mesh;
}

/** Cordoli bianco/rossi: strisce colorate ogni ~3 m, leggermente rialzate. */
function buildKerbs(track: TrackSpline): THREE.Mesh {
  const n = track.samples.length;
  const pos: number[] = [], col: number[] = [];
  const red = new THREE.Color('#c8261f').convertSRGBToLinear();
  const white = new THREE.Color('#eeeeee').convertSRGBToLinear();
  const stripe = 3; // metri per striscia

  for (let i = 0; i < n; i++) {
    const s0 = track.at(i), s1 = track.at(i + 1);
    const color = Math.floor(s0.s / stripe) % 2 === 0 ? red : white;
    for (const side of [1, -1]) {
      if (side === 1 ? !s0.kerbLeft : !s0.kerbRight) continue;
      const in0 = s0.width / 2, in1 = s1.width / 2;
      const out0 = in0 + KERB_WIDTH, out1 = in1 + KERB_WIDTH;
      // 4 angoli del quadrilatero (lato interno leggermente sotto al bordo esterno)
      const p = [
        [s0.x + s0.nx * in0 * side, Y_ROAD + 0.005, s0.z + s0.nz * in0 * side],
        [s0.x + s0.nx * out0 * side, Y_KERB, s0.z + s0.nz * out0 * side],
        [s1.x + s1.nx * in1 * side, Y_ROAD + 0.005, s1.z + s1.nz * in1 * side],
        [s1.x + s1.nx * out1 * side, Y_KERB, s1.z + s1.nz * out1 * side],
      ];
      // ordine dei triangoli scelto perché la faccia guardi in alto su entrambi i lati
      const tris = side === 1 ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 2, 1, 3];
      for (const k of tris) {
        pos.push(...p[k]);
        col.push(color.r, color.g, color.b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
  mesh.name = 'kerbs';
  mesh.receiveShadow = true;
  return mesh;
}

function buildGround(anisotropy: number, track: TrackSpline): THREE.Mesh {
  // il prato copre la pista con 1,5 km di margine (minimo 5 km di lato)
  const xs = track.samples.map((s) => s.x), zs = track.samples.map((s) => s.z);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const size = Math.ceil(Math.max(5000, Math.max(...xs) - Math.min(...xs) + 3000, Math.max(...zs) - Math.min(...zs) + 3000) / 8) * 8;
  const tex = grassTexture(anisotropy);
  tex.repeat.set(size / 8, size / 8);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    // polygonOffset: il prato viene sempre disegnato "dietro" asfalto e cordoli che gli stanno
    // appena sopra, anche da lontano (evita lo sfarfallio tra superfici quasi sovrapposte)
    new THREE.MeshStandardMaterial({ map: tex, roughness: 1, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(Math.round(cx / 8) * 8, 0, Math.round(cz / 8) * 8);
  mesh.name = 'ground';
  mesh.receiveShadow = true;
  return mesh;
}

/** Linea a scacchi. Il gruppo è orientato come la pista: X locale = trasversale, Z = avanti. */
function buildStartLine(track: TrackSpline): THREE.Group {
  const s = track.samples[0];
  const tex = checkerTexture();
  tex.repeat.set(s.width / 1.6, 1);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(s.width, 1.6),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }),
  );
  mesh.rotation.x = -Math.PI / 2; // da verticale a orizzontale
  mesh.position.y = Y_LINE;
  mesh.receiveShadow = true;
  const holder = new THREE.Group();
  holder.add(mesh);
  holder.position.set(s.x, 0, s.z);
  holder.rotation.y = s.heading;
  holder.name = 'start_line';
  return holder;
}

/** Portale sopra la linea di partenza (riferimento visivo). */
function buildGantry(track: TrackSpline): THREE.Group {
  const s = track.samples[0];
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#d9dde3', roughness: 0.5, metalness: 0.4 });
  const half = s.width / 2 + 3;
  for (const side of [1, -1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), mat);
    post.position.set(side * half, 3.5, 0);
    post.castShadow = true;
    g.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.6, 1.2, 0.8), mat);
  beam.position.set(0, 7, 0);
  beam.castShadow = true;
  g.add(beam);
  const banner = new THREE.Mesh(
    new THREE.BoxGeometry(half * 2 - 2, 0.9, 0.85),
    new THREE.MeshStandardMaterial({ color: '#1d4fa8', roughness: 0.6 }),
  );
  banner.position.set(0, 7, 0);
  g.add(banner);
  g.position.set(s.x, 0, s.z);
  g.rotation.y = s.heading;
  g.name = 'gantry';
  return g;
}

/** Alberi semplici (instanced: centinaia di alberi costano come uno). */
function buildTrees(track: TrackSpline): THREE.Group {
  const rnd = seededRandom(42);
  const minX = Math.min(...track.samples.map((s) => s.x)) - 250;
  const maxX = Math.max(...track.samples.map((s) => s.x)) + 250;
  const minZ = Math.min(...track.samples.map((s) => s.z)) - 250;
  const maxZ = Math.max(...track.samples.map((s) => s.z)) + 250;

  const coarse = track.samples.filter((_, i) => i % 10 === 0);
  const positions: [number, number, number][] = [];
  let tries = 0;
  // più alberi sulle piste lunghe (450 ogni ~2,5 km, al massimo 1400)
  const maxTrees = Math.round(Math.min(1400, 450 * Math.max(1, track.length / 2500)) * qualityParams(loadSettings().quality).treeFactor);
  while (positions.length < maxTrees && tries < maxTrees * 14) {
    tries++;
    const x = minX + rnd() * (maxX - minX);
    const z = minZ + rnd() * (maxZ - minZ);
    // non troppo vicino alla pista (controllo su un campione ogni ~20 m: veloce anche a Spa)
    let near = false;
    for (const c of coarse) if ((c.x - x) ** 2 + (c.z - z) ** 2 < (c.width / 2 + 32) ** 2) { near = true; break; }
    if (near) continue;
    if (track.pit) {
      const q = track.pit.project(x, z);
      if (q.s > -20 && q.s < track.pit.length + 20 && Math.abs(q.d) < track.pit.data.width / 2 + 30) continue;
    }
    // né sopra gli oggetti piazzati dall'utente
    if (track.data.props.some((o) => Math.hypot(o.x - x, o.z - z) < Math.max(o.size, PROP_CATALOG[o.type].depth(o.size)) / 2 + 8)) continue;
    positions.push([x, z, 0.7 + rnd() * 0.8]);
  }

  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3, 6);
  trunkGeo.translate(0, 1.5, 0);
  const crownGeo = new THREE.ConeGeometry(2.4, 7, 8);
  crownGeo.translate(0, 6, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#5a3d26', roughness: 1 }), positions.length);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: '#2f5a2a', roughness: 1 }), positions.length);
  const m = new THREE.Matrix4();
  positions.forEach(([x, z, sc], i) => {
    m.makeScale(sc, sc, sc).setPosition(x, 0, z);
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
  });
  trunks.castShadow = crowns.castShadow = true;
  const g = new THREE.Group();
  g.name = 'trees';
  g.add(trunks, crowns);
  return g;
}
