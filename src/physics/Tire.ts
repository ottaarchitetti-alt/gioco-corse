/**
 * Modello di gomma (Fase 1: versione base, estesa in Fase 2 con temperatura e usura).
 *
 * IDEA DI FONDO
 * La gomma genera forza perché "slitta" un po' rispetto all'asfalto:
 *   - slip ratio κ (longitudinale): quanto la ruota gira più veloce/lenta del suolo;
 *   - angolo di deriva α (laterale): quanto la ruota "punta" diversamente da dove va.
 * Fino a un certo slip (il picco) la forza cresce; oltre, la gomma scivola e la forza cala.
 *
 * SLIP COMBINATO (frenare e sterzare insieme)
 * Normalizziamo i due slip rispetto al loro picco: sx = κ/κpicco, sy = tanα/tan(αpicco).
 * Il modulo s = √(sx² + sy²) dice "quanto sei vicino al limite" (1 = al limite).
 * La forza totale disponibile dipende da s; poi la dividiamo tra le due direzioni
 * in proporzione a sx e sy. È una versione semplice del "cerchio di aderenza".
 *
 * RILASSAMENTO
 * La gomma non reagisce istantaneamente: lo slip "insegue" il suo valore teorico
 * con una costante di tempo = lunghezza di rilassamento / velocità.
 * Questo rende la simulazione stabile anche a bassa velocità.
 */
import { clamp, RAD } from '../core/math';
import type { TireParams } from './CarParams';

/** Curva normalizzata forza/slip: vale 0 a s=0, 1 al picco (s=1), poi scende verso slideFactor. */
export function tireCurve(s: number, slideFactor: number, falloff: number): number {
  if (s <= 1) return 1.5 * s - 0.5 * s * s * s; // cubica: pendenza iniziale 1.5, tangente orizzontale al picco
  const x = (s - 1) * falloff;
  return slideFactor + (1 - slideFactor) * Math.exp(-x * x);
}

/** Velocità sotto la quale si usano accorgimenti per la stabilità (m/s). */
const V_LOW = 1.5;

export interface TireOutput {
  fx: number; // forza longitudinale nel riferimento della ruota (N), + = in avanti
  fy: number; // forza laterale (N), + = verso sinistra
}

export class Tire {
  // --- Stato ---
  /** Velocità angolare ruota (rad/s), + = rotolamento in avanti. */
  omega = 0;
  /** Angolo di rotazione accumulato (solo per la grafica). */
  spin = 0;
  /** Slip ratio "rilassato". */
  kappa = 0;
  /** tan(angolo di deriva) "rilassato". */
  tanAlpha = 0;
  /** Carico verticale attuale (N). */
  load = 0;
  /** Valore normalizzato di slip combinato (1 = al limite). Utile per audio e telemetria. */
  combinedSlip = 0;
  /** Moltiplicatore di aderenza (Fase 2: temperatura, usura, pressione). */
  gripFactor = 1;

  constructor(public params: TireParams) {}

  reset(): void {
    this.omega = this.spin = this.kappa = this.tanAlpha = 0;
    this.combinedSlip = 0;
  }

  /**
   * Calcola le forze della gomma.
   * @param vx velocità del punto di contatto lungo l'asse della ruota (m/s)
   * @param vy velocità laterale del punto di contatto (m/s), + = verso sinistra
   * @param radius raggio di rotolamento (m)
   * @param surfaceGrip moltiplicatore di aderenza della superficie (asfalto 1, erba ~0.55)
   */
  computeForces(vx: number, vy: number, radius: number, surfaceGrip: number, dt: number): TireOutput {
    const p = this.params;
    const fz = this.load;
    if (fz <= 0) {
      this.combinedSlip = 0;
      return { fx: 0, fy: 0 };
    }

    // 1) Slip "teorici" istantanei
    const vRef = Math.max(Math.abs(vx), V_LOW);
    const slipVel = this.omega * radius - vx; // velocità di strisciamento longitudinale
    const kappaTarget = clamp(slipVel / vRef, -1.5, 1.5);
    const tanAlphaTarget = clamp(vy / vRef, -2, 2);

    // 2) Rilassamento: lo slip insegue il target con costante di tempo L / v
    const kLong = 1 - Math.exp((-vRef * dt) / p.relaxLong);
    const kLat = 1 - Math.exp((-vRef * dt) / p.relaxLat);
    this.kappa += (kappaTarget - this.kappa) * kLong;
    this.tanAlpha += (tanAlphaTarget - this.tanAlpha) * kLat;

    // 3) Slip combinato normalizzato
    const sx = this.kappa / p.peakSlipRatio;
    const sy = this.tanAlpha / Math.tan(p.peakSlipAngleDeg * RAD);
    const s = Math.hypot(sx, sy);
    this.combinedSlip = s;

    // 4) Aderenza disponibile: μ cala leggermente con il carico (sensibilità al carico)
    const loadRatio = fz / p.nominalLoad;
    const mu = p.mu * Math.max(0.5, 1 - p.loadSensitivity * (loadRatio - 1)) * surfaceGrip * this.gripFactor;
    const fMax = mu * fz;

    if (s < 1e-6) return { fx: 0, fy: 0 };
    const f = fMax * tireCurve(s, p.slideFactor, p.falloff);
    let fx = (f * sx) / s;
    let fy = (-f * sy) / s; // la forza laterale si oppone allo scivolamento

    // 5) Bassa velocità: piccolo smorzamento che ferma le oscillazioni residue
    if (Math.abs(vx) < V_LOW * 2) {
      const w = 1 - Math.abs(vx) / (V_LOW * 2);
      fy += clamp(-vy * fz * 0.4, -fMax, fMax) * w * 0.3;
    }
    fx = clamp(fx, -fMax, fMax);
    fy = clamp(fy, -fMax, fMax);
    return { fx, fy };
  }
}
