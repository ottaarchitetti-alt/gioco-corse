/**
 * Geometria della pista a partire dal file JSON (formato v2).
 *
 * Costruisce la curva di Bézier chiusa e la campiona ogni ~2 m.
 * Ogni campione conosce: posizione, direzione, normale verso sinistra,
 * larghezza, curvatura, presenza di cordoli, tratto di provenienza.
 *
 * COORDINATE PISTA (s, d)
 *   s = distanza lungo la linea centrale DALLA LINEA DI PARTENZA (m)
 *   d = spostamento laterale dalla linea centrale (m), + = a sinistra
 * Sono la base di cronometraggio, fuori pista, settori, griglia, bot e gap.
 *
 * Calcola anche: posizione dei settori, piazzole della griglia di partenza,
 * geometria della corsia box (PitLaneSpline).
 */
import { buildSegments, evalSegment, samplePath, type Segment } from './BezierPath';
import type { KerbMode, PitLane, TrackData, TrackRef, Vec2 } from './TrackData';

export interface TrackSample {
  x: number;
  z: number;
  s: number;
  /** Direzione di marcia (versore) */
  tx: number;
  tz: number;
  /** Normale verso sinistra (versore) */
  nx: number;
  nz: number;
  /** Direzione come angolo yaw (stessa convenzione del veicolo) */
  heading: number;
  width: number;
  /** Curvatura con segno (1/m), + = curva a sinistra */
  curvature: number;
  kerbLeft: boolean;
  kerbRight: boolean;
  /** Tratto dell'editor da cui proviene il campione */
  seg: number;
}

export interface TrackProjection {
  index: number;
  s: number;
  d: number;
  sample: TrackSample;
}

/** Posto in griglia: posizione e direzione */
export interface GridSlot {
  x: number;
  z: number;
  heading: number;
  s: number;
}

export const KERB_WIDTH = 1.4;
const SAMPLE_SPACING = 2;
/** Raggio sotto il quale i cordoli "auto" vengono messi */
const AUTO_KERB_RADIUS = 220;

/** Dati geometrici "orientati" (tangente, normale, curvatura) da una lista di punti. */
function orient<T extends { x: number; z: number }>(pts: T[], closed: boolean) {
  const n = pts.length;
  return pts.map((_, i) => {
    const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x, tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    return { tx, tz, nx: tz, nz: -tx, heading: Math.atan2(tx, tz) };
  });
}

export class TrackSpline {
  readonly samples: TrackSample[] = [];
  readonly length: number;
  readonly segments: Segment[];
  /** s (m) dei separatori dei settori, in ordine crescente */
  readonly sectorS: number[];
  readonly grid: GridSlot[];
  readonly pit: PitLaneSpline | null;

  constructor(public data: TrackData) {
    const pts = data.points;
    const N = pts.length;
    this.segments = buildSegments(pts, true);
    const { samples: raw, length } = samplePath(this.segments, SAMPLE_SPACING, true);
    this.length = length;
    const n = raw.length;
    const step = length / n;

    // Ruotiamo i campioni in modo che il primo sia sulla linea di partenza (s = 0 al traguardo)
    const startIdx = this.nearestRaw(raw, this.refPoint(data.start));
    const rot = (i: number) => raw[(i + startIdx) % n];
    const ori = orient(raw, true);

    for (let i = 0; i < n; i++) {
      const r = rot(i);
      const o = ori[(i + startIdx) % n];
      // larghezza interpolata tra i due punti del tratto (con raccordo morbido)
      const w0 = pts[r.seg].width ?? data.defaultWidth;
      const w1 = pts[(r.seg + 1) % N].width ?? data.defaultWidth;
      const f = r.t * r.t * (3 - 2 * r.t);
      this.samples.push({
        x: r.x, z: r.z, s: i * step,
        ...o,
        width: w0 + (w1 - w0) * f,
        curvature: 0,
        kerbLeft: false,
        kerbRight: false,
        seg: r.seg,
      });
    }

    // Curvatura = variazione di direzione per metro
    for (let i = 0; i < n; i++) {
      let dh = this.at(i + 1).heading - this.at(i - 1).heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      this.samples[i].curvature = dh / (2 * step);
    }

    this.applyKerbs();

    // Settori: dalla posizione nel tratto → distanza dal traguardo
    this.sectorS = data.sectors
      .map((ref) => this.project(this.refPoint(ref).x, this.refPoint(ref).z).s)
      .filter((s) => s > 5 && s < this.length - 5)
      .sort((a, b) => a - b);

    this.grid = this.buildGrid(data.gridSlots);
    this.pit = data.pitLane && data.pitLane.points.length >= 2 ? new PitLaneSpline(data.pitLane) : null;
  }

  /** Coordinate di un riferimento (tratto + frazione). */
  refPoint(ref: TrackRef): Vec2 {
    const seg = this.segments[((ref.seg % this.segments.length) + this.segments.length) % this.segments.length];
    return evalSegment(seg, Math.min(Math.max(ref.t, 0), 1));
  }

  private nearestRaw(raw: Vec2[], p: Vec2): number {
    let best = 0, bd = Infinity;
    raw.forEach((r, i) => {
      const d = (r.x - p.x) ** 2 + (r.z - p.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Cordoli: per ogni tratto la modalità scelta nell'editor; "auto" = nelle curve strette. */
  private applyKerbs(): void {
    const n = this.samples.length;
    const mode = (i: number): KerbMode => this.data.points[this.at(i).seg].kerb ?? 'auto';
    const corner = this.samples.map((s) => Math.abs(s.curvature) > 1 / AUTO_KERB_RADIUS);
    const extend = 6; // ~12 m prima e dopo la curva
    for (let i = 0; i < n; i++) {
      const m = mode(i);
      const smp = this.samples[i];
      if (m === 'auto') {
        let on = false;
        for (let k = -extend; k <= extend && !on; k++) on = corner[(i + k + n) % n];
        smp.kerbLeft = smp.kerbRight = on;
      } else {
        smp.kerbLeft = m === 'left' || m === 'both';
        smp.kerbRight = m === 'right' || m === 'both';
      }
    }
  }

  /** Griglia: posti sfalsati (sinistra/destra) dietro la linea di partenza, 8 m tra un posto e l'altro. */
  private buildGrid(count: number): GridSlot[] {
    const slots: GridSlot[] = [];
    for (let k = 0; k < count; k++) {
      const s = this.length - (6 + k * 8);
      const p = this.atS(s);
      const side = k % 2 === 0 ? 1 : -1; // pole position a sinistra
      const d = side * p.width * 0.22;
      slots.push({ x: p.x + p.nx * d, z: p.z + p.nz * d, heading: p.heading, s });
    }
    return slots;
  }

  /** Campione all'indice, con indici "circolari". */
  at(i: number): TrackSample {
    const n = this.samples.length;
    return this.samples[((i % n) + n) % n];
  }

  /** Campione più vicino a una distanza s. */
  atS(s: number): TrackSample {
    const n = this.samples.length;
    return this.at(Math.round((((s % this.length) + this.length) % this.length) / (this.length / n)));
  }

  /**
   * Proietta un punto del mondo sulla pista → (s, d).
   * @param hint indice da cui cercare (ultimo risultato): ricerca locale, molto veloce.
   *             -1 = ricerca su tutta la pista.
   */
  project(x: number, z: number, hint = -1): TrackProjection {
    const n = this.samples.length;
    let best = 0, bestD2 = Infinity;
    const scan = (i: number) => {
      const s = this.samples[i];
      const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    };
    if (hint < 0) for (let i = 0; i < n; i++) scan(i);
    else for (let k = -40; k <= 40; k++) scan((((hint + k) % n) + n) % n);
    const smp = this.samples[best];
    const dx = x - smp.x, dz = z - smp.z;
    let s = smp.s + dx * smp.tx + dz * smp.tz;
    if (s < 0) s += this.length;
    if (s >= this.length) s -= this.length;
    return { index: best, s, d: dx * smp.nx + dz * smp.nz, sample: smp };
  }
}

/** Campione della corsia box. */
export interface PitSample {
  x: number;
  z: number;
  s: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  heading: number;
}

/** Piazzola davanti a un box: dove l'auto si ferma per il pit stop (Fase 7). */
export interface PitStall {
  x: number;
  z: number;
  heading: number;
  s: number;
}

/**
 * Corsia box: curva aperta dall'ingresso all'uscita.
 * Il limite di velocità vale tra la linea di inizio e quella di fine limitatore.
 */
export class PitLaneSpline {
  readonly samples: PitSample[] = [];
  readonly length: number;
  /** s (m) delle linee del limitatore */
  readonly limiterStart: number;
  readonly limiterEnd: number;
  /** Due piazzole per box */
  readonly stalls: PitStall[] = [];
  /** Posizioni (centro) degli edifici dei box */
  readonly garages: PitStall[] = [];

  constructor(public data: PitLane) {
    const segs = buildSegments(data.points.map((p) => ({ ...p, handle: 'auto' as const })), false);
    const { samples, length } = samplePath(segs, 2, false);
    this.length = length;
    const ori = orient(samples, false);
    samples.forEach((p, i) => this.samples.push({ x: p.x, z: p.z, s: p.s, ...ori[i] }));

    this.limiterStart = Math.min(40, length * 0.15);
    this.limiterEnd = Math.max(length - 40, length * 0.85);
    const usable = this.limiterEnd - this.limiterStart - 20;
    const spacing = Math.min(14, usable / Math.max(1, data.garages));
    const first = (this.limiterStart + this.limiterEnd) / 2 - (spacing * (data.garages - 1)) / 2;
    const side = data.garageSide === 'left' ? 1 : -1;
    for (let g = 0; g < data.garages; g++) {
      const s = first + g * spacing;
      const p = this.atS(s);
      // l'auto si ferma vicino al lato dei box; il garage è appena oltre il bordo
      const dStall = side * data.width * 0.25;
      const dGarage = side * (data.width / 2 + 6);
      this.garages.push({ x: p.x + p.nx * dGarage, z: p.z + p.nz * dGarage, heading: p.heading, s });
      for (const off of [-spacing * 0.22, spacing * 0.22]) {
        const q = this.atS(s + off);
        this.stalls.push({ x: q.x + q.nx * dStall, z: q.z + q.nz * dStall, heading: q.heading, s: s + off });
      }
    }
  }

  atS(s: number): PitSample {
    const n = this.samples.length;
    const i = Math.round((Math.min(Math.max(s, 0), this.length) / this.length) * (n - 1));
    return this.samples[i];
  }

  /** Proiezione sulla corsia (come per la pista, ma su curva aperta). */
  project(x: number, z: number, hint = -1): { index: number; s: number; d: number } {
    const n = this.samples.length;
    let best = 0, bestD2 = Infinity;
    const from = hint < 0 ? 0 : Math.max(0, hint - 30), to = hint < 0 ? n - 1 : Math.min(n - 1, hint + 30);
    for (let i = from; i <= to; i++) {
      const s = this.samples[i];
      const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    const smp = this.samples[best];
    const dx = x - smp.x, dz = z - smp.z;
    return { index: best, s: smp.s + dx * smp.tx + dz * smp.tz, d: dx * smp.nx + dz * smp.nz };
  }
}
