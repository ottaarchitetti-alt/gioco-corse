/**
 * Modello di gomma: forze + temperatura + pressione + usura.
 *
 * FORZE
 * La gomma genera forza perché "slitta" un po' rispetto all'asfalto:
 *   - slip ratio κ (longitudinale): quanto la ruota gira più veloce/lenta del suolo;
 *   - angolo di deriva α (laterale): quanto la ruota "punta" diversamente da dove va.
 * Fino a un certo slip (il picco) la forza cresce; oltre, la gomma scivola e la forza cala.
 * Slip combinato: normalizziamo i due slip rispetto al picco, s = √(sx² + sy²)
 * (1 = al limite), e dividiamo la forza disponibile in proporzione ("cerchio di aderenza").
 * Rilassamento: lo slip insegue il suo valore teorico con un piccolo ritardo
 * (lunghezza di rilassamento / velocità): realistico e stabile a bassa velocità.
 *
 * TEMPERATURA (due strati)
 *   superficie: si scalda subito strisciando, si raffredda subito all'aria;
 *   carcassa:   segue lentamente la superficie, fa da "serbatoio".
 * Calore generato = parte della potenza di strisciamento + deformazione (rotolamento).
 * L'aderenza è massima vicino alla temperatura ideale della mescola:
 * gomme fredde e surriscaldate tengono meno.
 *
 * PRESSIONE
 * Si imposta a freddo; scaldandosi l'aria nella gomma si espande (legge dei gas).
 * Lontano dalla pressione ideale a caldo: meno aderenza. Pressione alta = gomma
 * più "rigida" (risposta più pronta, picco a deriva minore) ma meno impronta.
 *
 * USURA
 * Proporzionale all'energia di strisciamento: più scivoli, più consumi.
 * Crescente con la temperatura oltre l'ideale. Battistrada consumato = meno aderenza.
 */
import { clamp, RAD } from '../core/math';
import type { Compound, TireParams } from './CarParams';
import { ATM_BAR } from './constants';

/** Aderenza di una mescola con la pista bagnata `w` (0..1): moltiplicatore */
export function wetGripFactor(c: Compound, w: number): number {
  const g = c.wetGrip ?? [1, 0.6, 0.42]; // slick: crolla sul bagnato
  return w < 0.5 ? g[0] + (g[1] - g[0]) * (w / 0.5) : g[1] + (g[2] - g[1]) * ((w - 0.5) / 0.5);
}

/** Curva normalizzata forza/slip: 0 a s=0, 1 al picco (s=1), poi scende verso slideFactor. */
export function tireCurve(s: number, slideFactor: number, falloff: number): number {
  if (s <= 1) return 1.5 * s - 0.5 * s * s * s; // cubica: tangente orizzontale al picco
  const x = (s - 1) * falloff;
  return slideFactor + (1 - slideFactor) * Math.exp(-x * x);
}

/** Effetto della temperatura sull'aderenza (1 = ideale). Pubblica per HUD/grafici. */
export function temperatureGrip(t: number, optimal: number): number {
  const d = t - optimal;
  if (d < -8) {
    const x = Math.min(1, (-d - 8) / 55);
    return 1 - 0.12 * x * x - 0.03 * x; // freddo: fino a −15% a ~60 °C sotto l'ideale
  }
  if (d > 12) {
    const x = (d - 12) / 35;
    return Math.max(0.7, 1 - 0.2 * x * x); // caldo: cala più dolcemente, poi crolla
  }
  return 1; // finestra ideale
}

/** Effetto dell'usura (tread = battistrada rimasto, 1 = nuova). */
export function wearGrip(tread: number): number {
  const base = 1 - 0.05 * (1 - tread);
  const cliff = tread < 0.25 ? 0.45 * (0.25 - tread) : 0; // sotto il 25% si "scende dal dirupo"
  return base - cliff;
}

/** Velocità sotto la quale si usano accorgimenti per la stabilità (m/s). */
const V_LOW = 1.5;

export interface TireOutput {
  fx: number; // forza longitudinale nel riferimento della ruota (N), + = in avanti
  fy: number; // forza laterale (N), + = verso sinistra
}

/** Condizioni ambientali che influiscono sulla gomma. */
export interface TireEnvironment {
  airTemp: number;
  trackTemp: number;
  /** Moltiplicatore dell'usura (D9: per gare brevi con strategia) */
  wearMultiplier: number;
  /** Moltiplicatore del consumo di carburante */
  fuelMultiplier: number;
  /** Pista bagnata (0 = asciutta, 1 = fradicia): meteo */
  wetness?: number;
}

export class Tire {
  // --- Stato meccanico ---
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
  /** Slip combinato normalizzato (1 = al limite). Utile per audio e telemetria. */
  combinedSlip = 0;

  // --- Stato termico / usura ---
  surfaceTemp = 25;
  coreTemp = 25;
  /** Pressione a freddo impostata (bar) */
  coldPressure = 1.45;
  /** Pressione attuale (bar), calcolata dalla temperatura della carcassa */
  pressure = 1.45;
  /** Battistrada rimasto: 1 = nuova, 0 = finita */
  tread = 1;
  /** Fattore di aderenza complessivo attuale (mescola × temperatura × pressione × usura) */
  gripFactor = 1;
  /** Potenza di strisciamento attuale (W), per telemetria */
  slipPower = 0;

  compound: Compound;

  constructor(public params: TireParams, compoundId: string) {
    this.compound = params.compounds[compoundId] ?? Object.values(params.compounds)[0];
  }

  /** Azzera solo il moto (es. auto rimessa in pista): temperatura e usura restano. */
  resetMotion(): void {
    this.omega = this.spin = this.kappa = this.tanAlpha = 0;
    this.combinedSlip = 0;
  }

  /** Monta un treno nuovo. */
  fitNew(compoundId: string, coldPressure: number, startTemp: number, env: TireEnvironment): void {
    this.compound = this.params.compounds[compoundId] ?? this.compound;
    this.coldPressure = coldPressure;
    this.surfaceTemp = this.coreTemp = startTemp;
    this.tread = 1;
    this.updatePressure(env);
  }

  /** Temperatura "efficace" per l'aderenza: soprattutto la superficie. */
  get effectiveTemp(): number {
    return 0.7 * this.surfaceTemp + 0.3 * this.coreTemp;
  }

  private updatePressure(env: TireEnvironment): void {
    // Legge dei gas a volume costante: p_ass ∝ T (in kelvin). La pressione a freddo è riferita all'aria.
    this.pressure = ((this.coldPressure + ATM_BAR) * (this.coreTemp + 273.15)) / (env.airTemp + 273.15) - ATM_BAR;
  }

  /**
   * Calcola le forze della gomma e aggiorna temperatura e usura.
   * @param vx velocità del punto di contatto lungo l'asse della ruota (m/s)
   * @param vy velocità laterale del punto di contatto (m/s), + = verso sinistra
   * @param radius raggio di rotolamento (m)
   * @param surfaceGrip moltiplicatore di aderenza della superficie (asfalto 1, erba ~0.55)
   */
  computeForces(vx: number, vy: number, radius: number, surfaceGrip: number, env: TireEnvironment, dt: number): TireOutput {
    const p = this.params;
    const fz = this.load;

    // ---- Effetti di pressione, temperatura, usura ----
    const pDev = this.pressure - p.optimalPressure;
    const pressureGrip = 1 - 0.35 * pDev * pDev; // es. 0,3 bar fuori → −3%
    const peakAngle = p.peakSlipAngleDeg * clamp(1 - 0.3 * pDev, 0.8, 1.2);
    this.gripFactor =
      this.compound.muMul * temperatureGrip(this.effectiveTemp, this.compound.optimalTemp) * pressureGrip * wearGrip(this.tread);

    let fx = 0, fy = 0;
    if (fz > 0) {
      // 1) Slip "teorici" istantanei
      const vRef = Math.max(Math.abs(vx), V_LOW);
      const slipVel = this.omega * radius - vx; // velocità di strisciamento longitudinale
      const kappaTarget = clamp(slipVel / vRef, -1.5, 1.5);
      const tanAlphaTarget = clamp(vy / vRef, -2, 2);

      // 2) Rilassamento
      this.kappa += (kappaTarget - this.kappa) * (1 - Math.exp((-vRef * dt) / p.relaxLong));
      this.tanAlpha += (tanAlphaTarget - this.tanAlpha) * (1 - Math.exp((-vRef * dt) / p.relaxLat));

      // 3) Slip combinato normalizzato
      const sx = this.kappa / p.peakSlipRatio;
      const sy = this.tanAlpha / Math.tan(peakAngle * RAD);
      const s = Math.hypot(sx, sy);
      this.combinedSlip = s;

      // 4) Aderenza disponibile (sensibilità al carico)
      const loadRatio = fz / p.nominalLoad;
      const mu = p.mu * Math.max(0.5, 1 - p.loadSensitivity * (loadRatio - 1)) * surfaceGrip * this.gripFactor
        * wetGripFactor(this.compound, env.wetness ?? 0);
      const fMax = mu * fz;

      if (s > 1e-6) {
        const f = fMax * tireCurve(s, p.slideFactor, p.falloff);
        fx = (f * sx) / s;
        fy = (-f * sy) / s; // la forza laterale si oppone allo scivolamento
      }
      // 5) Bassa velocità: smorzamento che ferma le oscillazioni residue
      if (Math.abs(vx) < V_LOW * 2) {
        const w = 1 - Math.abs(vx) / (V_LOW * 2);
        fy += clamp(-vy * fz * 0.4, -fMax, fMax) * w * 0.3;
      }
      fx = clamp(fx, -fMax, fMax);
      fy = clamp(fy, -fMax, fMax);

      // Potenza dissipata strisciando: forza × velocità di strisciamento
      this.slipPower = Math.abs(fx * this.kappa * vRef) + Math.abs(fy * this.tanAlpha * vRef);
    } else {
      this.combinedSlip = 0;
      this.slipPower = 0;
    }

    this.updateThermal(Math.abs(vx), pDev, env, dt);
    return { fx, fy };
  }

  private updateThermal(speed: number, pDev: number, env: TireEnvironment, dt: number): void {
    const th = this.params.thermal;
    const loadRatio = this.load / this.params.nominalLoad;
    // Gomma sgonfia si deforma di più → scalda di più (e viceversa)
    const pressureHeat = clamp(1 - 0.5 * pDev, 0.7, 1.4);

    const heatSlip = this.slipPower * th.slipHeatFraction * this.compound.heatMul * pressureHeat;
    const heatRoll = this.params.rollingResistance * this.load * speed * 1.5 * pressureHeat;
    // l'acqua raffredda molto la gomma (le slick sul bagnato non vanno in temperatura)
    const wet = env.wetness ?? 0;
    const toAir = (th.airCoolBase + th.airCoolSpeed * speed) * (this.surfaceTemp - env.airTemp) * (1 + 2.5 * wet);
    const toTrack = th.trackConduct * loadRatio * (this.surfaceTemp - env.trackTemp);
    const toCore = th.surfaceToCore * (this.surfaceTemp - this.coreTemp);
    const coreLoss = th.coreToAir * (this.coreTemp - env.airTemp);

    this.surfaceTemp += ((heatSlip + heatRoll - toAir - toTrack - toCore) / th.surfaceCapacity) * dt;
    this.coreTemp += ((toCore - coreLoss) / th.coreCapacity) * dt;

    // Usura: energia di strisciamento, più rapida se la gomma è surriscaldata
    const over = Math.max(0, this.surfaceTemp - this.compound.optimalTemp - 15);
    // gomme da pioggia sull'asciutto: il battistrada morbido si sbriciola
    const tempWear = (1 + over / 20) * (this.compound.wet ? 1 + 3 * (1 - wet) * (1 - wet) : 1);
    this.tread = Math.max(
      0,
      this.tread - ((this.slipPower * th.wearPerMJ * this.compound.wearMul * tempWear * env.wearMultiplier) / 1e6) * dt,
    );

    this.updatePressure(env);
  }
}
