/**
 * Converte una TrackSpline in oggetti 3D: asfalto, cordoli, prato,
 * linea di partenza, portale e alberi di contorno.
 *
 * La pista NON si modella in Blender: viene generata da qui a partire dal
 * JSON dell'editor. In Blender si modellano solo gli elementi di contorno
 * (tribune, barriere, edifici) che in Fase 3 si posizioneranno dall'editor.
 */
import * as THREE from 'three';
import { asphaltTexture, checkerTexture, grassTexture, seededRandom } from '../render/textures';
import { KERB_WIDTH, TrackSpline } from './TrackSpline';

// Piccole altezze per evitare che superfici sovrapposte "sfarfallino"
const Y_ROAD = 0.02;
const Y_KERB = 0.035;
const Y_LINE = 0.03;
/** Lunghezza (m) di una ripetizione della texture d'asfalto */
const ASPHALT_REPEAT = 10;

export function buildTrackMesh(track: TrackSpline, anisotropy: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'track';
  group.add(buildRoad(track, anisotropy));
  group.add(buildKerbs(track));
  group.add(buildGround(anisotropy));
  group.add(buildStartLine(track));
  group.add(buildGantry(track));
  group.add(buildTrees(track));
  return group;
}

/** Nastro d'asfalto: due vertici per campione (bordo sinistro e destro). */
function buildRoad(track: TrackSpline, anisotropy: number): THREE.Mesh {
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
  const mat = new THREE.MeshStandardMaterial({ map: asphaltTexture(anisotropy), roughness: 0.92, metalness: 0 });
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

function buildGround(anisotropy: number): THREE.Mesh {
  const size = 5000;
  const tex = grassTexture(anisotropy);
  tex.repeat.set(size / 8, size / 8);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }),
  );
  mesh.rotation.x = -Math.PI / 2;
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

  const positions: [number, number, number][] = [];
  let tries = 0;
  while (positions.length < 450 && tries < 6000) {
    tries++;
    const x = minX + rnd() * (maxX - minX);
    const z = minZ + rnd() * (maxZ - minZ);
    const p = track.project(x, z);
    if (Math.abs(p.d) < p.sample.width / 2 + 30) continue; // non troppo vicino alla pista
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
