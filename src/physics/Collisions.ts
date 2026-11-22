/**
 * Collisioni tra auto (D5: scritte da noi, leggere).
 *
 * Ogni auto è un rettangolo orientato (vista dall'alto). Per ogni coppia vicina:
 *  1. test di sovrapposizione con il "teorema degli assi separanti" (SAT):
 *     se esiste una direzione in cui le proiezioni non si sovrappongono, non si toccano;
 *  2. se si toccano: le separiamo lungo la direzione di minima compenetrazione
 *     e applichiamo un IMPULSO (urto poco elastico + attrito) che cambia
 *     velocità e rotazione di entrambe, in proporzione a massa e inerzia.
 *
 * Convenzione di rotazione: yaw attorno a +Y (destrorsa), come in Vehicle.
 */
import type { Vehicle } from './Vehicle';

/** Mezza lunghezza e mezza larghezza predefinite della "scatola" dell'auto (m); ogni auto può avere le sue */
const HALF_L = 2.3;
const HALF_W = 1.0;
const RESTITUTION = 0.15;
const FRICTION = 0.35;

interface Box {
  cx: number;
  cz: number;
  fx: number; // asse avanti
  fz: number;
  lx: number; // asse sinistra
  lz: number;
  hl: number; // mezza lunghezza
  hw: number; // mezza larghezza
}

function boxOf(v: Vehicle): Box {
  const s = Math.sin(v.yaw), c = Math.cos(v.yaw);
  const dim = v.car.collision;
  return { cx: v.x, cz: v.z, fx: s, fz: c, lx: c, lz: -s, hl: dim?.halfLength ?? HALF_L, hw: dim?.halfWidth ?? HALF_W };
}

function corners(b: Box): [number, number][] {
  const out: [number, number][] = [];
  for (const a of [1, -1]) for (const w of [1, -1]) {
    out.push([b.cx + b.fx * b.hl * a + b.lx * b.hw * w, b.cz + b.fz * b.hl * a + b.lz * b.hw * w]);
  }
  return out;
}

function inside(b: Box, x: number, z: number): boolean {
  const dx = x - b.cx, dz = z - b.cz;
  return Math.abs(dx * b.fx + dz * b.fz) <= b.hl && Math.abs(dx * b.lx + dz * b.lz) <= b.hw;
}

/** Proiezione (raggio) della scatola su un asse */
function radius(b: Box, ax: number, az: number): number {
  return b.hl * Math.abs(b.fx * ax + b.fz * az) + b.hw * Math.abs(b.lx * ax + b.lz * az);
}

export interface CollisionEvent {
  a: Vehicle;
  b: Vehicle;
  /** velocità d'urto (m/s) */
  speed: number;
}

/** Risolve le collisioni tra tutte le coppie di auto. Restituisce gli urti avvenuti. */
export function resolveCollisions(cars: Vehicle[]): CollisionEvent[] {
  const events: CollisionEvent[] = [];
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const A = cars[i], B = cars[j];
      const dx = B.x - A.x, dz = B.z - A.z;
      if (dx * dx + dz * dz > 30) continue; // troppo lontane (fase "larga")
      const ev = collide(A, B);
      if (ev) events.push(ev);
    }
  }
  return events;
}

function collide(A: Vehicle, B: Vehicle): CollisionEvent | null {
  const a = boxOf(A), b = boxOf(B);
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  // SAT: 4 assi candidati; teniamo quello di minima compenetrazione
  let minPen = Infinity, nx = 0, nz = 0;
  for (const [ax, az] of [[a.fx, a.fz], [a.lx, a.lz], [b.fx, b.fz], [b.lx, b.lz]]) {
    const dist = dx * ax + dz * az;
    const pen = radius(a, ax, az) + radius(b, ax, az) - Math.abs(dist);
    if (pen <= 0) return null; // asse separante: nessun contatto
    if (pen < minPen) {
      minPen = pen;
      const sgn = dist >= 0 ? 1 : -1; // normale da A verso B
      nx = ax * sgn;
      nz = az * sgn;
    }
  }

  // Punto di contatto: media degli spigoli che stanno dentro l'altra auto
  const pts = [...corners(b).filter(([x, z]) => inside(a, x, z)), ...corners(a).filter(([x, z]) => inside(b, x, z))];
  let px = (a.cx + b.cx) / 2, pz = (a.cz + b.cz) / 2;
  if (pts.length) {
    px = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    pz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  }

  const mA = A.totalMass, mB = B.totalMass;
  const iA = A.car.yawInertia, iB = B.car.yawInertia;

  // 1) separazione delle posizioni (in proporzione inversa alle masse)
  const corr = minPen * 0.8;
  const wA = mB / (mA + mB), wB = mA / (mA + mB);
  A.x -= nx * corr * wA; A.z -= nz * corr * wA;
  B.x += nx * corr * wB; B.z += nz * corr * wB;

  // 2) impulso
  const rAx = px - A.x, rAz = pz - A.z;
  const rBx = px - B.x, rBz = pz - B.z;
  // velocità dei punti di contatto: v + ω × r  (ω attorno a +Y → (ω·rz, −ω·rx))
  const vAx = A.vx + A.yawRate * rAz, vAz = A.vz - A.yawRate * rAx;
  const vBx = B.vx + B.yawRate * rBz, vBz = B.vz - B.yawRate * rBx;
  const rvx = vBx - vAx, rvz = vBz - vAz;
  const vn = rvx * nx + rvz * nz;
  if (vn >= 0) return null; // si stanno già allontanando

  // "braccio" dell'impulso per la rotazione: (r × n) attorno a Y = rz·nx − rx·nz
  const crossA = rAz * nx - rAx * nz;
  const crossB = rBz * nx - rBx * nz;
  const k = 1 / mA + 1 / mB + (crossA * crossA) / iA + (crossB * crossB) / iB;
  const jn = (-(1 + RESTITUTION) * vn) / k;

  // attrito tangenziale (limitato dal cono di Coulomb)
  const tx = -nz, tz = nx;
  const vt = rvx * tx + rvz * tz;
  const crossAt = rAz * tx - rAx * tz, crossBt = rBz * tx - rBx * tz;
  const kt = 1 / mA + 1 / mB + (crossAt * crossAt) / iA + (crossBt * crossBt) / iB;
  const jt = Math.max(-FRICTION * jn, Math.min(FRICTION * jn, -vt / kt));

  const Jx = nx * jn + tx * jt, Jz = nz * jn + tz * jt;
  A.vx -= Jx / mA; A.vz -= Jz / mA;
  B.vx += Jx / mB; B.vz += Jz / mB;
  // momento: τ = (r × J)·Y = rz·Jx − rx·Jz
  A.yawRate -= (rAz * Jx - rAx * Jz) / iA;
  B.yawRate += (rBz * Jx - rBx * Jz) / iB;

  return { a: A, b: B, speed: -vn };
}
