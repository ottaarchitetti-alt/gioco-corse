/**
 * TRAIETTORIA IDEALE e PROFILO DI VELOCITÀ, calcolati automaticamente per
 * qualsiasi pista (anche quelle disegnate nell'editor).
 *
 * 1) Traiettoria: per ogni campione della pista cerchiamo uno spostamento
 *    laterale (offset) che renda la linea il più "dritta" possibile
 *    (curvatura minima), restando dentro la carreggiata. È ciò che fa un
 *    pilota: allarga in ingresso, tocca la corda, allarga in uscita.
 *    Metodo: discesa del gradiente sull'energia di curvatura, prima su una
 *    pista "grossolana" (punti ogni 20 m) e poi più fine (ogni 6 m).
 *
 * 2) Velocità: in ogni punto la velocità massima in curva dipende da
 *    aderenza e deportanza (v² = μ·(g + k·v²) / curvatura). Poi due passate:
 *    in avanti (quanto si riesce ad accelerare, con potenza e aderenza
 *    residua) e all'indietro (dove bisogna iniziare a frenare).
 */
import { RPM_TO_RADS } from '../core/math';
import { AIR_DENSITY } from '../physics/Aero';
import type { CarParams } from '../physics/CarParams';
import { GRAVITY } from '../physics/constants';
import type { TrackSpline } from '../track/TrackSpline';

/** Distanza (m) tenuta dal bordo pista dal centro dell'auto */
const EDGE_MARGIN = 1.35;

export class RacingLine {
  /** Offset laterale dalla linea centrale per ogni campione della pista (m, + = sinistra) */
  readonly offset: Float32Array;
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** Curvatura con segno della traiettoria (1/m) */
  readonly curvature: Float32Array;
  /** Distanza tra campioni consecutivi lungo la traiettoria (m) */
  readonly ds: Float32Array;
  readonly n: number;
  /** Zone di aerodinamica attiva (monoposto): 1 = ali aperte in rettilineo */
  aeroZones: Uint8Array | null = null;

  constructor(readonly track: TrackSpline) {
    const smp = track.samples;
    const n = (this.n = smp.length);
    this.offset = new Float32Array(n);

    // Ottimizzazione multi-risoluzione
    // (punti ogni ~20 m, poi ogni ~6 m: il numero di punti dipende dalla LUNGHEZZA della pista)
    let coarse = this.optimize(Math.max(20, Math.round(track.length / 20)), null);
    coarse = this.optimize(Math.max(40, Math.round(track.length / 6)), coarse);
    // dal livello fine a tutti i campioni (interpolazione lineare)
    const m = coarse.length;
    for (let i = 0; i < n; i++) {
      const f = (i / n) * m;
      const a = Math.floor(f) % m, b = (a + 1) % m;
      this.offset[i] = coarse[a] + (coarse[b] - coarse[a]) * (f - Math.floor(f));
    }

    this.x = new Float32Array(n);
    this.z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = smp[i];
      this.x[i] = s.x + s.nx * this.offset[i];
      this.z[i] = s.z + s.nz * this.offset[i];
    }
    // Rifinitura: la linea centrale ha piccole irregolarità (punti di raccordo delle curve,
    // tracciati importati): le togliamo smussando la traiettoria (~15 m), sempre dentro la pista.
    const lim = (i: number) => Math.max(0, smp[i].width / 2 - EDGE_MARGIN);
    const tx = new Float32Array(n), tz = new Float32Array(n);
    for (let pass = 0; pass < 24; pass++) {
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n, b2 = (i + 1) % n;
        tx[i] = (this.x[a] + 2 * this.x[i] + this.x[b2]) / 4;
        tz[i] = (this.z[a] + 2 * this.z[i] + this.z[b2]) / 4;
      }
      for (let i = 0; i < n; i++) {
        const s = smp[i];
        const off = Math.max(-lim(i), Math.min(lim(i), (tx[i] - s.x) * s.nx + (tz[i] - s.z) * s.nz));
        this.offset[i] = off;
        this.x[i] = s.x + s.nx * off;
        this.z[i] = s.z + s.nz * off;
      }
    }
    this.ds = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.ds[i] = Math.hypot(this.x[j] - this.x[i], this.z[j] - this.z[i]);
    }
    // curvatura dalla variazione di direzione
    this.curvature = new Float32Array(n);
    const heading = (i: number) => {
      const a = (i + n) % n, b = (i + 1 + n) % n;
      return Math.atan2(this.x[b] - this.x[a], this.z[b] - this.z[a]);
    };
    for (let i = 0; i < n; i++) {
      let dh = heading(i) - heading(i - 1);
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      this.curvature[i] = dh / Math.max(0.1, (this.ds[i] + this.ds[(i - 1 + n) % n]) / 2);
    }
    // leggera media per togliere il "rumore" numerico
    const k = new Float32Array(this.curvature);
    for (let i = 0; i < n; i++) {
      this.curvature[i] = (k[(i - 2 + n) % n] + 2 * k[(i - 1 + n) % n] + 3 * k[i] + 2 * k[(i + 1) % n] + k[(i + 2) % n]) / 9;
    }
  }

  /**
   * Discesa del gradiente su m punti equidistanti.
   * @param init offset iniziali (da un livello più grossolano) oppure null (linea centrale)
   */
  private optimize(m: number, init: number[] | null): number[] {
    const t = this.track;
    const n = t.samples.length;
    const pts = Array.from({ length: m }, (_, k) => t.samples[Math.floor((k / m) * n)]);
    const limit = pts.map((p) => Math.max(0, p.width / 2 - EDGE_MARGIN));
    const a = new Float64Array(m);
    if (init) {
      const mi = init.length;
      for (let k = 0; k < m; k++) {
        const f = (k / m) * mi;
        const i0 = Math.floor(f) % mi, i1 = (i0 + 1) % mi;
        a[k] = init[i0] + (init[i1] - init[i0]) * (f - Math.floor(f));
      }
    }
    const px = new Float64Array(m), pz = new Float64Array(m);
    const cx = new Float64Array(m), cz = new Float64Array(m);
    const iters = init ? 1500 : 3000;
    const step = 0.045;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < m; k++) {
        px[k] = pts[k].x + pts[k].nx * a[k];
        pz[k] = pts[k].z + pts[k].nz * a[k];
      }
      // seconda differenza (≈ curvatura) in ogni punto
      for (let k = 0; k < m; k++) {
        const p = (k - 1 + m) % m, q = (k + 1) % m;
        cx[k] = px[p] - 2 * px[k] + px[q];
        cz[k] = pz[p] - 2 * pz[k] + pz[q];
      }
      // gradiente dell'energia Σ|c|² rispetto a ogni punto, proiettato sulla normale
      for (let k = 0; k < m; k++) {
        const p = (k - 1 + m) % m, q = (k + 1) % m;
        const gx = cx[p] - 2 * cx[k] + cx[q];
        const gz = cz[p] - 2 * cz[k] + cz[q];
        const g = gx * pts[k].nx + gz * pts[k].nz;
        a[k] = Math.max(-limit[k], Math.min(limit[k], a[k] - step * 2 * g));
      }
    }
    return Array.from(a);
  }

  /**
   * Profilo di velocità (m/s per campione) per un'auto e un livello di aderenza.
   * @param gripScale frazione dell'aderenza teorica sfruttata (0.8 = prudente, 1 = al limite)
   * @param brakeScale frazione della decelerazione massima usata in frenata
   */
  speedProfile(car: CarParams, gripScale: number, brakeScale: number): Float32Array {
    const n = this.n;
    const m = car.mass + car.fuelKg;
    // aderenza "efficace" della gomma calda: la sensibilità al carico e il trasferimento
    // di carico riducono quella nominale (tarato in simulazione: 1,0 ≈ limite reale)
    const mu = car.tire.mu * (car.botGripFactor ?? 0.85) * gripScale;
    // effetto suolo (monoposto): col carico l'auto si abbassa e il fondo genera più deportanza
    // (in media circa un terzo del guadagno massimo); conta solo nelle curve veloci
    const ground = car.groundEffect ? 1 + car.groundEffect.gain * 0.3 : 1;
    const kDown = (0.5 * AIR_DENSITY * car.liftArea * ground) / m; // accelerazione extra per (m/s)²
    const kDragCorner = (0.5 * AIR_DENSITY * car.dragArea) / m;
    // ali aperte nelle zone di aerodinamica attiva: meno resistenza in rettilineo
    const kDragStraight = car.activeAero ? (0.5 * AIR_DENSITY * car.activeAero.straightDragArea) / m : kDragCorner;
    const zones = this.aeroZones;
    const kDragAt = (i: number) => (zones && zones[i] ? kDragStraight : kDragCorner);
    // potenza massima alle ruote (motore termico)
    let pMax = 0;
    for (const [rpm, nm] of car.torqueCurve) pMax = Math.max(pMax, nm * rpm * RPM_TO_RADS);
    pMax *= car.drivetrainEfficiency;
    // spinta elettrica media su un giro (la batteria non basta per spingere sempre al massimo)
    const ers = car.ers;
    const pErs = (kmh: number) => {
      if (!ers) return 0;
      const taper = kmh <= ers.taperStartKmh ? 1 : Math.max(0, 1 - (kmh - ers.taperStartKmh) / (ers.taperEndKmh - ers.taperStartKmh));
      return ers.deployKW * 1000 * 0.55 * taper * car.drivetrainEfficiency;
    };
    const vTop = 105;

    const v = new Float32Array(n);
    // 1) limite in curva
    for (let i = 0; i < n; i++) {
      const k = Math.abs(this.curvature[i]);
      const denom = k - mu * kDown;
      v[i] = denom <= 1e-5 ? vTop : Math.min(vTop, Math.sqrt((mu * GRAVITY) / denom));
    }
    const grip = (vv: number) => mu * (GRAVITY + kDown * vv * vv);
    // 2) passate in avanti (accelerazione) e all'indietro (frenata), due giri per chiudere l'anello
    for (let pass = 0; pass < 2; pass++) {
      for (let c = 0; c < n; c++) {
        const i = c, j = (c + 1) % n;
        const vi = v[i];
        const lat = vi * vi * Math.abs(this.curvature[i]);
        const tot = grip(vi);
        const longAvail = Math.sqrt(Math.max(0, tot * tot - lat * lat)) * 0.55; // trazione posteriore
        const power = (pMax + pErs(vi * 3.6)) / (m * Math.max(vi, 5)) - kDragAt(i) * vi * vi;
        const acc = Math.max(0, Math.min(longAvail, power));
        v[j] = Math.min(v[j], Math.sqrt(vi * vi + 2 * acc * this.ds[i]));
      }
      for (let c = n - 1; c >= 0; c--) {
        const i = c, j = (c + 1) % n;
        const vj = v[j];
        const lat = vj * vj * Math.abs(this.curvature[j]);
        const tot = grip(vj);
        const dec = Math.sqrt(Math.max(0, tot * tot - lat * lat)) * brakeScale + kDragCorner * vj * vj;
        v[i] = Math.min(v[i], Math.sqrt(vj * vj + 2 * dec * this.ds[i]));
      }
    }
    return v;
  }
}
