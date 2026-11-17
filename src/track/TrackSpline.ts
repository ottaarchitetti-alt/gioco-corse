/**
 * Geometria della pista a partire dai punti di controllo.
 *
 * Costruisce una spline Catmull-Rom chiusa (centripeta: niente "anelli" strani
 * tra punti a distanze molto diverse) e la campiona ogni ~2 m.
 * Ogni campione conosce: posizione, direzione, normale verso sinistra,
 * larghezza, curvatura, presenza di cordoli.
 *
 * COORDINATE PISTA (s, d)
 *   s = distanza percorsa lungo la linea centrale dalla linea di partenza (m)
 *   d = spostamento laterale dalla linea centrale (m), + = a sinistra
 * Sono la base di cronometraggio, fuori pista, bot, gap e corsia box.
 */
import * as THREE from 'three';
import type { TrackData } from './TrackData';

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
}

export interface TrackProjection {
  index: number;
  s: number;
  d: number;
  sample: TrackSample;
}

export const KERB_WIDTH = 1.4;
const SAMPLE_SPACING = 2;

export class TrackSpline {
  readonly samples: TrackSample[] = [];
  readonly length: number;

  constructor(public data: TrackData) {
    const pts = data.points.map((p) => new THREE.Vector3(p.x, 0, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    const n = Math.max(50, Math.round(curve.getLength() / SAMPLE_SPACING));
    const spaced = curve.getSpacedPoints(n); // n+1 punti, l'ultimo coincide con il primo
    this.length = curve.getLength();
    const step = this.length / n;
    const N = pts.length;

    for (let i = 0; i < n; i++) {
      const p = spaced[i];
      const next = spaced[(i + 1) % n];
      const prev = spaced[(i - 1 + n) % n];
      let tx = next.x - prev.x, tz = next.z - prev.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;

      // Larghezza interpolata tra i punti di controllo
      const t = curve.getUtoTmapping(i / n, 0) * N;
      const i0 = Math.floor(t) % N, i1 = (i0 + 1) % N;
      const f = t - Math.floor(t);
      const w0 = data.points[i0].width ?? data.defaultWidth;
      const w1 = data.points[i1].width ?? data.defaultWidth;

      this.samples.push({
        x: p.x, z: p.z, s: i * step,
        tx, tz,
        nx: tz, nz: -tx, // sinistra = (cos yaw, -sin yaw) con avanti = (sin yaw, cos yaw)
        heading: Math.atan2(tx, tz),
        width: w0 + (w1 - w0) * f,
        curvature: 0,
        kerbLeft: false,
        kerbRight: false,
      });
    }

    // Curvatura = variazione di direzione per metro
    for (let i = 0; i < n; i++) {
      const a = this.samples[(i - 1 + n) % n].heading;
      const b = this.samples[(i + 1) % n].heading;
      let dh = b - a;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      this.samples[i].curvature = dh / (2 * step);
    }

    if (data.kerbs === 'auto') this.autoKerbs();
  }

  /** Cordoli dove la curva ha raggio < ~220 m, estesi un po' prima e dopo. */
  private autoKerbs(): void {
    const n = this.samples.length;
    const corner = this.samples.map((s) => Math.abs(s.curvature) > 1 / 220);
    const extend = 6; // campioni (~12 m)
    for (let i = 0; i < n; i++) {
      let on = false;
      for (let k = -extend; k <= extend && !on; k++) on = corner[(i + k + n) % n];
      this.samples[i].kerbLeft = on;
      this.samples[i].kerbRight = on;
    }
  }

  /** Campione all'indice, con indici "circolari". */
  at(i: number): TrackSample {
    const n = this.samples.length;
    return this.samples[((i % n) + n) % n];
  }

  /**
   * Proietta un punto del mondo sulla pista → (s, d).
   * @param hint indice da cui cercare (ultimo risultato): ricerca locale, molto veloce.
   *             -1 = ricerca su tutta la pista.
   */
  project(x: number, z: number, hint = -1): TrackProjection {
    const n = this.samples.length;
    let best = 0, bestD2 = Infinity;
    if (hint < 0) {
      for (let i = 0; i < n; i++) {
        const s = this.samples[i];
        const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
    } else {
      const win = 40;
      for (let k = -win; k <= win; k++) {
        const i = (((hint + k) % n) + n) % n;
        const s = this.samples[i];
        const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
    }
    const smp = this.samples[best];
    const dx = x - smp.x, dz = z - smp.z;
    const along = dx * smp.tx + dz * smp.tz; // spostamento lungo la tangente
    let s = smp.s + along;
    if (s < 0) s += this.length;
    if (s >= this.length) s -= this.length;
    return { index: best, s, d: dx * smp.nx + dz * smp.nz, sample: smp };
  }
}
