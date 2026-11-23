/**
 * Monoposto 2026: AERODINAMICA ATTIVA, EFFETTO SUOLO e SISTEMA IBRIDO (ERS).
 *
 * AERODINAMICA ATTIVA
 *   Nelle "zone" (rettilinei lunghi, calcolati dalla pista) a pieno gas le ali
 *   si aprono: resistenza e deportanza calano (modalità rettilineo). Appena si
 *   frena, si alza il piede o finisce la zona si richiudono (modalità curva).
 *   Il passaggio non è istantaneo (~0,3 s), come i flap veri.
 *
 * EFFETTO SUOLO
 *   Il fondo genera più carico quanto più è vicino all'asfalto: l'altezza da
 *   terra cala con la deportanza (le molle si comprimono) e con l'assetto.
 *   Se il fondo tocca terra ("talloneggia") una parte del carico si perde.
 *
 * ERS (batteria + motore elettrico MGU-K)
 *   - in frenata e in rilascio il motore elettrico RECUPERA energia (fino a
 *     harvestPerLapMJ per giro, batteria al massimo batteryMJ);
 *   - a gas spalancato SPINGE fino a deployKW in più del motore termico; sopra
 *     taperStartKmh la spinta cala fino a zero a taperEndKmh (regola 2026);
 *   - OVERTAKE MODE: se al traguardo eri entro 1 s da chi ti precede, nel giro
 *     dopo puoi attivarlo: spinta piena fino a velocità più alta + energia extra.
 *   Modalità del pilota: bilanciata, attacco (spinge fino a batteria vuota),
 *   ricarica (non spinge e recupera di più).
 */
import { clamp } from '../core/math';
import type { CarParams } from './CarParams';
import type { TrackSpline } from '../track/TrackSpline';

export type ErsMode = 'bilanciata' | 'attacco' | 'ricarica';
export const ERS_MODES: ErsMode[] = ['bilanciata', 'attacco', 'ricarica'];
export const ERS_MODE_NAMES: Record<ErsMode, string> = { bilanciata: 'Bilanciata', attacco: 'Attacco', ricarica: 'Ricarica' };

/** Coppia massima del motore elettrico all'albero motore (Nm): limita la spinta a bassa velocità */
const MGUK_MAX_CRANK_TORQUE = 500;

export class HybridSystem {
  /** Energia in batteria (J) */
  battery: number;
  /** Energia recuperata nel giro in corso (J) */
  harvestedLap = 0;
  mode: ErsMode = 'bilanciata';
  /** Overtake mode: concesso per il giro in corso / attivato dal pilota */
  overtakeAvailable = false;
  overtakeActive = false;
  /** Energia extra dell'Overtake mode ancora da usare (J) */
  private overtakeBank = 0;
  /** Potenza istantanea (W): + spinta, - recupero (per HUD e telemetria) */
  power = 0;
  /** Aerodinamica attiva: 0 = ali chiuse (curva), 1 = aperte (rettilineo) */
  aeroOpen = 0;
  /** La pista dice se l'auto è in una zona di aerodinamica attiva (lo imposta Game) */
  inAeroZone = false;
  /** Quanto della spinta elettrica usare (0..1): lo regola il bot per non sprecarla dove le ruote slittano */
  deployScale = 1;

  constructor(private car: CarParams) {
    this.battery = (car.ers?.batteryMJ ?? 0) * 1e6 * 0.6;
  }

  get hasErs(): boolean {
    return !!this.car.ers;
  }
  get hasActiveAero(): boolean {
    return !!this.car.activeAero;
  }
  /** Carica in frazione 0..1 */
  get charge(): number {
    const cap = (this.car.ers?.batteryMJ ?? 0) * 1e6;
    return cap > 0 ? this.battery / cap : 0;
  }

  /** Nuovo giro: azzera il recupero e decide l'Overtake mode. */
  newLap(overtakeEarned: boolean): void {
    this.harvestedLap = 0;
    this.overtakeAvailable = overtakeEarned;
    this.overtakeActive = false;
    this.overtakeBank = 0;
  }

  /** Il pilota preme il pulsante dell'Overtake mode. */
  toggleOvertake(): boolean {
    if (!this.overtakeAvailable) return false;
    this.overtakeActive = !this.overtakeActive;
    if (this.overtakeActive && this.overtakeBank === 0) this.overtakeBank = (this.car.ers?.overtakeExtraMJ ?? 0) * 1e6;
    return true;
  }

  reset(): void {
    this.aeroOpen = 0;
    this.power = 0;
  }

  /** Aree aerodinamiche attuali (Cd·A e Cl·A), con l'apertura delle ali. */
  aeroAreas(): { drag: number; lift: number } {
    const car = this.car, a = car.activeAero;
    if (!a) return { drag: car.dragArea, lift: car.liftArea };
    const k = this.aeroOpen;
    return { drag: car.dragArea + (a.straightDragArea - car.dragArea) * k, lift: car.liftArea + (a.straightLiftArea - car.liftArea) * k };
  }

  /** Apre/chiude le ali: aperte solo in zona, a gas quasi pieno, senza freno, sopra ~100 km/h. */
  updateAero(dt: number, throttle: number, brake: number, speed: number): void {
    if (!this.car.activeAero) return;
    const want = this.inAeroZone && throttle > 0.85 && brake < 0.05 && speed > 28 ? 1 : 0;
    // si aprono in ~0,35 s, si chiudono più in fretta (~0,2 s): in frenata serve subito il carico
    const rate = want > this.aeroOpen ? 1 / 0.35 : 1 / 0.2;
    this.aeroOpen = clamp(this.aeroOpen + Math.sign(want - this.aeroOpen) * rate * dt, 0, 1);
  }

  /**
   * Moltiplicatore di deportanza dell'effetto suolo.
   * @param rideHeight altezza da terra statica scelta nell'assetto (m)
   * @param heave scuotimento della carrozzeria (m, + = più alta)
   * @param pitch beccheggio (rad, + = muso giù) e passo, per l'altezza del muso/coda
   */
  groundEffectFactor(rideHeight: number, heave: number, pitch: number, halfWheelbase: number): number {
    const ge = this.car.groundEffect;
    if (!ge) return 1;
    const h = rideHeight + heave;
    const front = h - pitch * halfWheelbase, rear = h + pitch * halfWheelbase;
    let f = 1 + ge.gain * clamp((ge.refRideHeight - h) / ge.refRideHeight, -0.8, 0.7);
    // fondo a terra: perdita di carico (proporzionale a quanto "affonda")
    const low = Math.min(front, rear);
    if (low < 0.006) f *= 1 - ge.bottomingLoss * clamp((0.006 - low) / 0.01, 0, 1);
    return f;
  }

  /**
   * Energia: recupero e spinta per questo passo.
   * @returns coppia extra all'albero motore (Nm) da sommare a quella del motore termico
   */
  updateEnergy(dt: number, throttle: number, brake: number, speed: number, crankOmega: number, coupled: boolean): number {
    const e = this.car.ers;
    this.power = 0;
    if (!e) return 0;
    const cap = e.batteryMJ * 1e6;
    const harvestLeft = e.harvestPerLapMJ * 1e6 - this.harvestedLap;

    // ---- Recupero ----
    let harvest = 0;
    let fromEngine = false;
    const kmh = speed * 3.6;
    if (speed > 5) {
      if (brake > 0.05) harvest = e.harvestKW * 1000; // frenata: il motore elettrico recupera al massimo
      else if (throttle < 0.05) harvest = e.coastHarvestKW * 1000 * (this.mode === 'ricarica' ? 1.6 : 1);
      else if (throttle < 0.6) harvest = e.coastHarvestKW * 1000 * 0.6; // gas parziale: un po' di ricarica
      else if (throttle > 0.95 && coupled && (kmh > e.taperEndKmh - 25 || this.mode === 'ricarica')) {
        // "SUPER CLIPPING": a fine rettilineo (dove la spinta elettrica non è più ammessa) il motore
        // termico fa girare il generatore e ricarica la batteria, a scapito della velocità
        harvest = (this.mode === 'ricarica' ? 250 : 180) * 1000;
        fromEngine = true;
      }
    }
    harvest = Math.min(harvest, Math.max(0, harvestLeft) / dt, Math.max(0, cap - this.battery) / dt);
    if (harvest > 0) {
      this.battery += harvest * dt;
      this.harvestedLap += harvest * dt;
      this.power = -harvest;
      // il recupero dal motore termico toglie coppia alle ruote
      return fromEngine && crankOmega > 50 ? -harvest / crankOmega : 0;
    }

    // ---- Spinta ----
    if (!coupled || throttle < 0.6 || this.mode === 'ricarica' || crankOmega < 50) return 0;
    const reserve = this.mode === 'bilanciata' ? 0.05 * cap : 0;
    const usable = this.battery - reserve + this.overtakeBank;
    if (usable <= 0) return 0;
    const start = this.overtakeActive ? e.overtakeTaperStartKmh : e.taperStartKmh;
    const end = start + (e.taperEndKmh - e.taperStartKmh);
    const taper = kmh <= start ? 1 : clamp(1 - (kmh - start) / (end - start), 0, 1);
    let p = e.deployKW * 1000 * taper * clamp((throttle - 0.6) / 0.35, 0, 1) * this.deployScale;
    if (p <= 0) return 0;
    p = Math.min(p, usable / dt);
    const torque = Math.min(MGUK_MAX_CRANK_TORQUE, p / crankOmega);
    p = torque * crankOmega;
    // prima si consuma l'energia extra dell'Overtake mode, poi la batteria
    const fromBank = Math.min(this.overtakeBank, p * dt);
    this.overtakeBank -= fromBank;
    this.battery -= p * dt - fromBank;
    this.power = p;
    return torque;
  }
}

/**
 * Zone di aerodinamica attiva della pista: tratti quasi dritti abbastanza lunghi.
 * Restituisce 1 per i campioni della pista in zona, 0 altrove.
 */
export function activeAeroZones(track: TrackSpline, car: CarParams): Uint8Array {
  const n = track.samples.length;
  const zones = new Uint8Array(n);
  const a = car.activeAero;
  if (!a) return zones;
  const step = track.length / n;
  // curvatura mediata su ~30 m (le piccole correzioni del tracciato non interrompono la zona)
  const straight = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (let j = -7; j <= 7; j++) k = Math.max(k, Math.abs(track.at(i + j).curvature));
    straight[i] = k < a.maxCurvature ? 1 : 0;
  }
  // cerca l'inizio di un tratto non dritto, per non spezzare una zona a cavallo del traguardo
  let start = straight.indexOf(0);
  if (start < 0) { zones.fill(1); return zones; }
  let runStart = -1;
  for (let c = 1; c <= n; c++) {
    const i = (start + c) % n;
    if (straight[i] && runStart < 0) runStart = c;
    if ((!straight[i] || c === n) && runStart >= 0) {
      const len = (c - runStart) * step;
      // la zona finisce ~60 m prima della curva: le ali sono già chiuse quando si frena
      const cut = Math.round(60 / step);
      if (len >= a.minZoneLength) for (let k = runStart; k < c - cut; k++) zones[(start + k) % n] = 1;
      runStart = -1;
    }
  }
  return zones;
}
