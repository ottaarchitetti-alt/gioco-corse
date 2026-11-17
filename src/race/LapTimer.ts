/**
 * Cronometraggio sul giro, basato sulla coordinata s della pista.
 *
 * - Il tempo si misura sommando i dt FISICI (non il tempo reale): è preciso
 *   e non dipende dal frame rate.
 * - L'istante di passaggio sul traguardo viene interpolato dentro il passo
 *   fisico (precisione ben sotto il millesimo).
 * - Limiti della pista: giro annullato se tutte e 4 le ruote escono.
 * (Fase 4: settori, delta live, record per sessione.)
 */
import { loadJSON, saveJSON } from '../core/storage';

export type LapEvent =
  | { type: 'lap'; time: number; valid: boolean; best: boolean }
  | { type: 'invalidated' };

export class LapTimer {
  /** 0 = giro di uscita (prima del primo passaggio sul traguardo) */
  lap = 0;
  current = 0;
  lastLap: number | null = null;
  bestLap: number | null = null;
  valid = true;

  private prevS = -1;
  private readonly recordKey: string;

  constructor(private trackLength: number, trackId: string, carId: string, private onEvent: (e: LapEvent) => void) {
    this.recordKey = `record.${trackId}.${carId}`;
    this.bestLap = loadJSON<{ t: number | null }>(this.recordKey, { t: null }).t;
  }

  reset(): void {
    this.lap = 0;
    this.current = 0;
    this.valid = true;
    this.prevS = -1;
  }

  /** Invalida il giro (es. reset dell'auto in pista). */
  invalidate(): void {
    if (this.lap > 0 && this.valid) {
      this.valid = false;
      this.onEvent({ type: 'invalidated' });
    }
  }

  update(dt: number, s: number, allWheelsOff: boolean): void {
    const L = this.trackLength;
    if (this.lap > 0) this.current += dt;
    if (allWheelsOff) this.invalidate();

    if (this.prevS >= 0) {
      if (this.prevS > L * 0.75 && s < L * 0.25) {
        // Passaggio in avanti sul traguardo: interpoliamo l'istante esatto
        const before = L - this.prevS;
        const total = before + s;
        const frac = total > 0 ? before / total : 1;
        this.crossLine(dt * (1 - frac));
      } else if (this.prevS < L * 0.25 && s > L * 0.75) {
        // Traguardo attraversato al contrario: il giro non vale
        this.invalidate();
      }
    }
    this.prevS = s;
  }

  /** @param overshoot tempo già trascorso dopo il traguardo in questo passo */
  private crossLine(overshoot: number): void {
    if (this.lap > 0) {
      const time = this.current - overshoot;
      this.lastLap = time;
      let best = false;
      if (this.valid && (this.bestLap === null || time < this.bestLap)) {
        this.bestLap = time;
        best = true;
        saveJSON(this.recordKey, { t: time });
      }
      this.onEvent({ type: 'lap', time, valid: this.valid, best });
    }
    this.lap++;
    this.current = overshoot;
    this.valid = true;
  }
}
