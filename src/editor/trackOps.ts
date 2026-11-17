/**
 * Operazioni di modifica della pista (pure: lavorano sui dati, senza grafica).
 * Si occupano anche di tenere coerenti partenza e settori quando i punti cambiano.
 */
import { buildSegments, evalSegment, resolveHandles, splitSegment } from '../track/BezierPath';
import type { KerbMode, TrackData, TrackPoint, TrackRef, Vec2 } from '../track/TrackData';

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });

/** Tratto e parametro più vicini a un punto del mondo. */
export function nearestRef(data: TrackData, p: Vec2): TrackRef & { dist: number } {
  const segs = buildSegments(data.points, true);
  let best = { seg: 0, t: 0, dist: Infinity };
  segs.forEach((s, si) => {
    for (let k = 0; k <= 64; k++) {
      const t = k / 64;
      const q = evalSegment(s, t);
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < best.dist) best = { seg: si, t: Math.min(t, 0.999), dist: d };
    }
  });
  return best;
}

function refs(data: TrackData): TrackRef[] {
  return [data.start, ...data.sectors];
}

/** Inserisce un punto nel tratto `seg` al parametro t, mantenendo la forma. */
export function insertPoint(data: TrackData, seg: number, t: number): number {
  const pts = data.points;
  const n = pts.length;
  const i = seg, j = (seg + 1) % n;
  const segs = buildSegments(pts, true);
  const [a, b] = splitSegment(segs[seg], t);

  const np: TrackPoint = { x: round(a.p1.x), z: round(a.p1.z), handle: 'auto', kerb: pts[i].kerb ?? 'auto' };
  if (pts[i].width !== undefined || pts[j].width !== undefined) {
    const wi = pts[i].width ?? data.defaultWidth, wj = pts[j].width ?? data.defaultWidth;
    np.width = round(wi + (wj - wi) * t);
  }

  const allAuto = (pts[i].handle ?? 'auto') === 'auto' && (pts[j].handle ?? 'auto') === 'auto';
  if (!allAuto) {
    // Divisione esatta (de Casteljau): la forma della curva non cambia
    const h = resolveHandles(pts, true);
    for (const k of [i, j]) {
      if ((pts[k].handle ?? 'auto') === 'auto') {
        pts[k].handle = 'smooth';
        pts[k].hin = h[k].hin;
        pts[k].hout = h[k].hout;
      }
    }
    pts[i].hout = sub(a.c1, a.p0);
    np.handle = 'smooth';
    np.hin = sub(a.c2, a.p1);
    np.hout = sub(b.c1, b.p0);
    pts[j].hin = sub(b.c2, b.p1);
  }
  pts.splice(i + 1, 0, np);

  for (const r of refs(data)) {
    if (r.seg > i) r.seg++;
    else if (r.seg === i) {
      if (r.t < t) r.t = r.t / t;
      else {
        r.seg = i + 1;
        r.t = (r.t - t) / (1 - t);
      }
    }
  }
  return i + 1;
}

/** Elimina un punto (ne servono almeno 3). */
export function deletePoint(data: TrackData, i: number): boolean {
  const n = data.points.length;
  if (n <= 3) return false;
  data.points.splice(i, 1);
  for (const r of refs(data)) {
    if (r.seg === i) {
      r.seg = (i - 1 + (n - 1)) % (n - 1);
      r.t = 0.5 + r.t / 2;
    } else if (r.seg > i) r.seg--;
  }
  return true;
}

const swapLR = (k: KerbMode | undefined): KerbMode =>
  k === 'left' ? 'right' : k === 'right' ? 'left' : (k ?? 'auto');

/** Inverte il senso di marcia. */
export function reverseTrack(data: TrackData): void {
  const old = data.points;
  const n = old.length;
  const rev: TrackPoint[] = [];
  for (let m = n - 1; m >= 0; m--) {
    const p = old[m];
    rev.push({
      ...p,
      hin: p.hout, hout: p.hin,
      // il cordolo del tratto in arrivo diventa quello del tratto in partenza, con i lati scambiati
      kerb: swapLR(old[(m - 1 + n) % n].kerb),
    });
  }
  data.points = rev;
  for (const r of refs(data)) {
    r.seg = (((n - 2 - r.seg) % n) + n) % n;
    r.t = Math.min(0.999, 1 - r.t);
  }
  if (data.pitLane) {
    data.pitLane.points.reverse();
    data.pitLane.garageSide = data.pitLane.garageSide === 'left' ? 'right' : 'left';
  }
}

/** Trasforma un punto "auto" in maniglie modificabili (prima di trascinarne una). */
export function freezeHandles(data: TrackData, i: number, mode: 'smooth' | 'corner'): void {
  const h = resolveHandles(data.points, true)[i];
  const p = data.points[i];
  p.hin = { ...h.hin };
  p.hout = { ...h.hout };
  p.handle = mode;
}

/** Muove una maniglia; in modalità "smooth" quella opposta resta allineata. */
export function moveHandle(data: TrackData, i: number, which: 'hin' | 'hout', rel: Vec2, breakLink: boolean): void {
  const p = data.points[i];
  if ((p.handle ?? 'auto') === 'auto') freezeHandles(data, i, breakLink ? 'corner' : 'smooth');
  else if (breakLink) p.handle = 'corner';
  p[which] = { x: round(rel.x, 100), z: round(rel.z, 100) };
  if (p.handle === 'smooth') {
    const other = which === 'hin' ? 'hout' : 'hin';
    const o = p[other]!;
    const len = Math.hypot(o.x, o.z);
    const l = Math.hypot(rel.x, rel.z) || 1;
    p[other] = { x: (-rel.x / l) * len, z: (-rel.z / l) * len };
  }
}

export function round(v: number, k = 10): number {
  return Math.round(v * k) / k;
}
