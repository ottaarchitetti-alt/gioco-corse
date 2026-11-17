/**
 * Cronometraggio di UN concorrente (pilota o bot: stesso codice).
 *
 * Si basa sulla coordinata s della pista (distanza dal traguardo):
 *   - giro completato quando s "riparte da zero" andando avanti;
 *   - settore completato quando s supera il separatore;
 *   - il tempo si misura sommando i dt FISICI (preciso, indipendente dal frame rate);
 *   - l'istante di passaggio viene interpolato dentro il passo fisico.
 *
 * Giro NON VALIDO se: tutte e 4 le ruote fuori pista, traguardo passato al
 * contrario, auto riposizionata, oppure "salto" di posizione (taglio).
 *
 * Tiene anche:
 *   - la traccia tempo/posizione del giro (ogni 10 m) per il DELTA in tempo reale;
 *   - la distanza totale percorsa e i tempi di passaggio, per ordine e distacchi in gara.
 */

export interface LapRecord {
  lap: number;
  time: number;
  sectors: (number | null)[];
  valid: boolean;
}

export type TimingEvent =
  | { type: 'lap'; lap: LapRecord; sessionBest: boolean }
  | { type: 'sector'; index: number; time: number }
  | { type: 'invalidated'; reason: string }
  | { type: 'lineCrossed' };

/** Passo della traccia per il delta (m) */
export const TRACE_STEP = 10;

export class LapTiming {
  /** Giro in corso: 0 = giro di uscita (prima del primo passaggio) */
  lap = 0;
  /** Tempo del giro in corso (s) */
  current = 0;
  valid = true;
  /** Tempi dei settori del giro in corso (null = non ancora completato) */
  currentSectors: (number | null)[];
  sectorIndex = 0;
  readonly laps: LapRecord[] = [];
  /** Miglior giro VALIDO della sessione */
  best: LapRecord | null = null;
  /** Miglior tempo di ogni settore nella sessione (solo giri validi fino a quel punto) */
  readonly bestSectors: (number | null)[];
  /** Traccia del giro in corso e del miglior giro: tempo ogni TRACE_STEP metri di s */
  private trace: number[] = [];
  bestTrace: number[] | null = null;

  /** Distanza totale da inizio sessione (m) e tempo di sessione (s): per la classifica di gara */
  totalDistance = 0;
  sessionTime = 0;
  /** Tempo di sessione al passaggio di ogni 10 m di distanza totale */
  private checkpoints: number[] = [0];

  /** In gara la griglia è dietro il traguardo: il primo passaggio non chiude un giro */
  ignoreNextCrossing = false;
  /** Se false il cronometro è fermo (es. prima del via) */
  running = true;

  private prevS = -1;
  private lapDistance = 0;
  private sectorStart = 0;

  constructor(
    private length: number,
    private sectorS: number[],
    private onEvent: (e: TimingEvent) => void = () => {},
  ) {
    this.currentSectors = new Array(sectorS.length + 1).fill(null);
    this.bestSectors = new Array(sectorS.length + 1).fill(null);
  }

  get sectorCount(): number {
    return this.sectorS.length + 1;
  }

  /** Inizia il giro 1 subito (partenza di una gara). */
  startRace(): void {
    this.lap = 1;
    this.current = 0;
    this.sectorStart = 0;
    this.sectorIndex = 0;
    this.valid = true;
    this.lapDistance = 0;
    this.trace = [];
    this.ignoreNextCrossing = true;
  }

  invalidate(reason: string): void {
    if (this.lap > 0 && this.valid) {
      this.valid = false;
      this.onEvent({ type: 'invalidated', reason });
    }
  }

  /** Dimentica la posizione precedente (dopo un riposizionamento dell'auto). */
  resetPosition(): void {
    this.prevS = -1;
  }

  /** Tempo di sessione in cui il concorrente aveva percorso la distanza d (per i distacchi). */
  timeAtDistance(d: number): number | null {
    if (d < 0) return 0;
    const k = d / TRACE_STEP;
    const i = Math.floor(k);
    if (i + 1 >= this.checkpoints.length) return null;
    const f = k - i;
    return this.checkpoints[i] + (this.checkpoints[i + 1] - this.checkpoints[i]) * f;
  }

  /** Delta rispetto a una traccia di riferimento alla posizione s (+ = più lento). */
  deltaAt(s: number, ref: number[] | null): number | null {
    if (!ref || this.lap === 0) return null;
    const k = s / TRACE_STEP;
    const i = Math.floor(k);
    if (i + 1 >= ref.length) return null;
    const refT = ref[i] + (ref[i + 1] - ref[i]) * (k - i);
    return this.current - refT;
  }

  /** Traccia del giro in corso (copiata a fine giro) */
  get currentTrace(): number[] {
    return this.trace;
  }

  /**
   * Da chiamare a ogni passo fisico.
   * @param s posizione sulla pista
   * @param allWheelsOff tutte e 4 le ruote fuori dalla pista (limiti)
   */
  update(dt: number, s: number, allWheelsOff: boolean): void {
    if (!this.running) {
      this.prevS = s;
      return;
    }
    const L = this.length;
    this.sessionTime += dt;
    if (this.lap > 0) this.current += dt;
    if (allWheelsOff) this.invalidate('limiti della pista');

    if (this.prevS < 0) {
      this.prevS = s;
      return;
    }
    // spostamento con segno, tenendo conto del passaggio L → 0
    let ds = s - this.prevS;
    if (ds < -L / 2) ds += L;
    if (ds > L / 2) ds -= L;
    if (Math.abs(ds) > 30) this.invalidate('taglio o riposizionamento'); // impossibile in un passo da 1/240 s

    // distanza totale e tempi di passaggio (solo in avanti: indietro non si "guadagna")
    this.totalDistance += ds;
    this.lapDistance += ds;
    while ((this.checkpoints.length) * TRACE_STEP <= this.totalDistance) {
      this.checkpoints.push(this.sessionTime);
    }

    // traccia per il delta
    if (this.lap > 0) {
      while (this.trace.length * TRACE_STEP <= s && this.trace.length * TRACE_STEP < L) this.trace.push(this.current);
    }

    const prev = this.prevS;
    this.prevS = s;

    // ---- Settori (dentro il giro, senza attraversare il traguardo) ----
    if (this.lap > 0 && ds > 0 && s > prev) {
      while (this.sectorIndex < this.sectorS.length && prev < this.sectorS[this.sectorIndex] && s >= this.sectorS[this.sectorIndex]) {
        const frac = (this.sectorS[this.sectorIndex] - prev) / (s - prev);
        const t = this.current - dt * (1 - frac);
        this.closeSector(t);
      }
    }

    // ---- Traguardo ----
    if (prev > L * 0.75 && s < L * 0.25) {
      const before = L - prev;
      const frac = before / (before + s);
      this.crossLine(dt * (1 - frac));
    } else if (prev < L * 0.25 && s > L * 0.75) {
      this.invalidate('traguardo al contrario');
    }
  }

  private closeSector(atTime: number): void {
    const i = this.sectorIndex;
    const time = atTime - this.sectorStart;
    this.currentSectors[i] = time;
    this.sectorStart = atTime;
    this.sectorIndex++;
    if (this.valid && (this.bestSectors[i] === null || time < this.bestSectors[i]!)) this.bestSectors[i] = time;
    this.onEvent({ type: 'sector', index: i, time });
  }

  /** @param overshoot tempo già trascorso dopo il traguardo in questo passo */
  private crossLine(overshoot: number): void {
    if (this.ignoreNextCrossing) {
      this.ignoreNextCrossing = false;
      this.lapDistance = 0;
      this.trace = [];
      this.onEvent({ type: 'lineCrossed' });
      return;
    }
    if (this.lap > 0) {
      // un "giro" troppo corto (es. avanti e indietro sulla linea) non conta
      if (this.lapDistance < this.length * 0.5) return;
      const time = this.current - overshoot;
      // ultimo settore
      this.sectorIndex = this.sectorS.length;
      const lastSector = time - this.sectorStart;
      this.currentSectors[this.sectorIndex] = lastSector;
      const li = this.sectorIndex;
      if (this.valid && (this.bestSectors[li] === null || lastSector < this.bestSectors[li]!)) this.bestSectors[li] = lastSector;

      const rec: LapRecord = { lap: this.lap, time, sectors: [...this.currentSectors], valid: this.valid };
      this.laps.push(rec);
      let sessionBest = false;
      if (rec.valid && (!this.best || time < this.best.time)) {
        this.best = rec;
        this.bestTrace = [...this.trace];
        sessionBest = true;
      }
      this.onEvent({ type: 'lap', lap: rec, sessionBest });
    }
    this.lap++;
    this.current = overshoot;
    this.valid = true;
    this.sectorIndex = 0;
    this.sectorStart = 0;
    this.lapDistance = 0;
    this.currentSectors = new Array(this.sectorS.length + 1).fill(null);
    this.trace = [];
    // dopo l'evento "lap": chi ascolta può prima salvare il giro concluso, poi ripartire
    this.onEvent({ type: 'lineCrossed' });
  }
}
