/**
 * Curve di Bézier cubiche a tratti (chiuse per la pista, aperte per la corsia box).
 *
 * Ogni tratto i va dal punto P[i] al punto P[i+1] con due punti di controllo:
 *   P[i] + hout[i]   e   P[i+1] + hin[i+1]
 * Le maniglie "auto" sono calcolate in modo che la curva passi morbida per i
 * punti (tangente parallela alla retta tra il punto precedente e il successivo).
 */
import type { HandleMode, Vec2 } from './TrackData';

export interface PathPoint extends Vec2 {
  handle?: HandleMode;
  hin?: Vec2;
  hout?: Vec2;
}

/** Tratto pronto da valutare: estremi e punti di controllo assoluti. */
export interface Segment {
  p0: Vec2;
  c1: Vec2;
  c2: Vec2;
  p1: Vec2;
}

/** Campione lungo la curva. */
export interface PathSample extends Vec2 {
  /** indice del tratto e parametro 0..1 dentro il tratto */
  seg: number;
  t: number;
  /** distanza dall'inizio della curva (m) */
  s: number;
}

/** Maniglie automatiche per il punto i. */
export function autoHandles(pts: Vec2[], i: number, closed: boolean): { hin: Vec2; hout: Vec2 } {
  const n = pts.length;
  const p = pts[i];
  const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
  const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
  let dx = next.x - prev.x, dz = next.z - prev.z;
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const lenOut = Math.hypot(next.x - p.x, next.z - p.z) / 3;
  const lenIn = Math.hypot(p.x - prev.x, p.z - prev.z) / 3;
  return { hin: { x: -dx * lenIn, z: -dz * lenIn }, hout: { x: dx * lenOut, z: dz * lenOut } };
}

/** Maniglie effettive (relative) di ogni punto. */
export function resolveHandles(pts: PathPoint[], closed: boolean): { hin: Vec2; hout: Vec2 }[] {
  return pts.map((p, i) => {
    const auto = autoHandles(pts, i, closed);
    if (!p.handle || p.handle === 'auto') return auto;
    return { hin: p.hin ?? auto.hin, hout: p.hout ?? auto.hout };
  });
}

export function buildSegments(pts: PathPoint[], closed: boolean): Segment[] {
  const h = resolveHandles(pts, closed);
  const n = pts.length;
  const count = closed ? n : n - 1;
  const segs: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n;
    segs.push({
      p0: { x: pts[i].x, z: pts[i].z },
      c1: { x: pts[i].x + h[i].hout.x, z: pts[i].z + h[i].hout.z },
      c2: { x: pts[j].x + h[j].hin.x, z: pts[j].z + h[j].hin.z },
      p1: { x: pts[j].x, z: pts[j].z },
    });
  }
  return segs;
}

/** Punto della Bézier cubica al parametro t. */
export function evalSegment(s: Segment, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * s.p0.x + b * s.c1.x + c * s.c2.x + d * s.p1.x,
    z: a * s.p0.z + b * s.c1.z + c * s.c2.z + d * s.p1.z,
  };
}

/** Divide un tratto in due al parametro t (algoritmo di de Casteljau): serve per inserire punti. */
export function splitSegment(s: Segment, t: number): [Segment, Segment] {
  const lerp = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  const ab = lerp(s.p0, s.c1), bc = lerp(s.c1, s.c2), cd = lerp(s.c2, s.p1);
  const abc = lerp(ab, bc), bcd = lerp(bc, cd);
  const m = lerp(abc, bcd);
  return [
    { p0: s.p0, c1: ab, c2: abc, p1: m },
    { p0: m, c1: bcd, c2: cd, p1: s.p1 },
  ];
}

/**
 * Campiona la curva a distanza costante (spacing metri).
 * Prima valuta molti punti per tratto, poi ricampiona per lunghezza d'arco.
 */
export function samplePath(segs: Segment[], spacing: number, closed: boolean): { samples: PathSample[]; length: number } {
  const SUB = 48;
  const dense: PathSample[] = [];
  let s = 0;
  let prev: Vec2 | null = null;
  segs.forEach((seg, si) => {
    for (let k = 0; k < SUB; k++) {
      const t = k / SUB;
      const p = evalSegment(seg, t);
      if (prev) s += Math.hypot(p.x - prev.x, p.z - prev.z);
      dense.push({ x: p.x, z: p.z, seg: si, t, s });
      prev = p;
    }
  });
  // punto finale
  const last = segs[segs.length - 1];
  const end = closed ? segs[0].p0 : last.p1;
  s += Math.hypot(end.x - prev!.x, end.z - prev!.z);
  const length = s;
  dense.push({ x: end.x, z: end.z, seg: closed ? 0 : segs.length - 1, t: closed ? 0 : 1, s });

  const n = Math.max(closed ? 20 : 2, Math.round(length / spacing));
  const step = length / n;
  const out: PathSample[] = [];
  let j = 0;
  const count = closed ? n : n + 1;
  for (let i = 0; i < count; i++) {
    const target = i * step;
    while (j < dense.length - 2 && dense[j + 1].s < target) j++;
    const a = dense[j], b = dense[j + 1];
    const f = b.s > a.s ? (target - a.s) / (b.s - a.s) : 0;
    // il parametro t si interpola solo dentro lo stesso tratto
    const sameSeg = a.seg === b.seg;
    out.push({
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
      seg: a.seg,
      t: sameSeg ? a.t + (b.t - a.t) * f : a.t + (1 - a.t) * f,
      s: target,
    });
  }
  return { samples: out, length };
}
