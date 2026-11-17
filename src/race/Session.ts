/**
 * Sessione: prove libere, qualifica o gara.
 *
 * Gestisce lo svolgimento (stati), il tempo/giri rimasti, il semaforo di
 * partenza, la bandiera a scacchi e la classifica. Lavora su una lista di
 * CONCORRENTI: per ora solo il pilota, dalla Fase 5 anche i bot (stesso codice).
 *
 * Stati:
 *   semaforo  → solo in gara: luci che si accendono, poi si spengono = via
 *   corsa     → sessione in svolgimento
 *   bandiera  → tempo scaduto / giri completati: ognuno finisce al prossimo passaggio
 *   finita    → risultati
 */
import type { Difficulty } from '../ai/BotDriver';
import { LapTiming, type TimingEvent } from './LapTiming';

export type SessionType = 'libere' | 'qualifica' | 'gara';
export type SessionState = 'semaforo' | 'corsa' | 'bandiera' | 'finita';

export interface SessionConfig {
  type: SessionType;
  /** Durata in minuti (prove/qualifica). 0 = illimitata (solo prove libere) */
  minutes: number;
  /** Giri di gara */
  laps: number;
  /** Numero di avversari bot (0–19) */
  opponents: number;
  difficulty: Difficulty;
  /** Posizione di partenza del pilota in gara */
  grid: GridMode;
}

export type GridMode = 'qualifica' | 'pole' | 'meta' | 'fondo';
export const GRID_NAMES: Record<GridMode, string> = {
  qualifica: 'Ordine della qualifica',
  pole: 'In pole position',
  meta: 'A metà griglia',
  fondo: 'In fondo alla griglia',
};

export const SESSION_NAMES: Record<SessionType, string> = {
  libere: 'Prove libere',
  qualifica: 'Qualifica',
  gara: 'Gara',
};

/** Penalità per partenza anticipata (s) */
export const JUMP_START_PENALTY = 5;

export class Competitor {
  readonly timing: LapTiming;
  finished = false;
  /** Tempo di gara all'arrivo (s, senza penalità) */
  finishTime: number | null = null;
  /** Penalità di tempo accumulate (s) */
  penalty = 0;
  position = 1;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly isPlayer: boolean,
    trackLength: number,
    sectorS: number[],
    onEvent: (c: Competitor, e: TimingEvent) => void,
  ) {
    this.timing = new LapTiming(trackLength, sectorS, (e) => onEvent(this, e));
  }

  /** Giri completati */
  get lapsDone(): number {
    return this.timing.laps.length;
  }
}

export type SessionEvent =
  | { type: 'lights'; count: number }
  | { type: 'go' }
  | { type: 'jumpStart'; c: Competitor }
  | { type: 'flag' }
  | { type: 'finished'; c: Competitor }
  | { type: 'end' };

export class Session {
  state: SessionState;
  /** Tempo trascorso dal via (s) */
  clock = 0;
  /** Luci accese (0..5) durante la procedura di partenza */
  lights = 0;
  readonly competitors: Competitor[] = [];
  private lightsTimer = 0;
  private lightsOutDelay: number;
  private flagTime = 0;

  constructor(readonly config: SessionConfig, private trackLength: number, private onEvent: (e: SessionEvent) => void) {
    this.state = config.type === 'gara' ? 'semaforo' : 'corsa';
    // le luci si spengono dopo un ritardo casuale (come in F1): impossibile anticipare
    this.lightsOutDelay = 0.4 + Math.random() * 2.2;
  }

  get name(): string {
    return SESSION_NAMES[this.config.type];
  }

  get isRace(): boolean {
    return this.config.type === 'gara';
  }

  /** Secondi rimasti (null = illimitata o gara) */
  get timeLeft(): number | null {
    if (this.isRace || this.config.minutes <= 0) return null;
    return Math.max(0, this.config.minutes * 60 - this.clock);
  }

  get leader(): Competitor | undefined {
    return this.standings()[0];
  }

  add(c: Competitor): void {
    this.competitors.push(c);
    // In gara il cronometro parte al via
    if (this.isRace) c.timing.running = false;
  }

  /**
   * Avanza la sessione (dopo aver aggiornato il cronometraggio dei concorrenti).
   * @param movedFromGrid per ogni concorrente: metri percorsi dalla posizione di partenza
   */
  update(dt: number, movedFromGrid: (c: Competitor) => number): void {
    if (this.state === 'finita') return;

    if (this.state === 'semaforo') {
      this.lightsTimer += dt;
      const lit = Math.min(5, Math.floor(this.lightsTimer / 1.0));
      if (lit !== this.lights) {
        this.lights = lit;
        this.onEvent({ type: 'lights', count: lit });
      }
      // partenza anticipata: l'auto si muove prima che le luci si spengano
      for (const c of this.competitors) {
        if (c.penalty === 0 && movedFromGrid(c) > 1.0) {
          c.penalty += JUMP_START_PENALTY;
          this.onEvent({ type: 'jumpStart', c });
        }
      }
      if (this.lightsTimer >= 5 + this.lightsOutDelay) {
        this.lights = 0;
        this.state = 'corsa';
        for (const c of this.competitors) {
          c.timing.running = true;
          c.timing.startRace();
        }
        this.onEvent({ type: 'go' });
      }
      return;
    }

    this.clock += dt;

    if (this.state === 'corsa') {
      const timeUp = this.timeLeft === 0;
      const leaderDone = this.isRace && this.competitors.some((c) => c.lapsDone >= this.config.laps);
      if (timeUp || leaderDone) {
        this.state = 'bandiera';
        this.flagTime = this.clock;
        this.onEvent({ type: 'flag' });
        // in gara il leader ha appena tagliato il traguardo: ha finito
        if (leaderDone) for (const c of this.competitors) if (c.lapsDone >= this.config.laps) this.finish(c);
      }
    }

    // Fine sessione: quando tutti hanno finito (o 2 minuti dopo la bandiera)
    if (this.state === 'bandiera') {
      if (this.competitors.every((c) => c.finished) || this.clock - this.flagTime > 120) {
        this.state = 'finita';
        this.onEvent({ type: 'end' });
      }
    }
    this.updatePositions();
  }

  /** Da chiamare quando un concorrente passa sul traguardo. */
  onLineCrossed(c: Competitor): void {
    if (this.state === 'bandiera' && !c.finished) {
      // In prova/qualifica: la bandiera chiude il giro in corso.
      // In gara: si finisce al primo passaggio dopo la bandiera.
      this.finish(c);
    }
  }

  private finish(c: Competitor): void {
    c.finished = true;
    c.finishTime = c.timing.sessionTime;
    this.onEvent({ type: 'finished', c });
  }

  /** Il pilota lascia la sessione prima della fine (per le prove libere illimitate). */
  end(): void {
    this.state = 'finita';
    this.onEvent({ type: 'end' });
  }

  /** Classifica attuale. */
  standings(): Competitor[] {
    const list = [...this.competitors];
    if (this.isRace) {
      list.sort((a, b) => {
        if (a.finished && b.finished) return a.finishTime! + a.penalty - (b.finishTime! + b.penalty);
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        return b.timing.totalDistance - a.timing.totalDistance;
      });
    } else {
      list.sort((a, b) => (a.timing.best?.time ?? Infinity) - (b.timing.best?.time ?? Infinity));
    }
    return list;
  }

  private updatePositions(): void {
    this.standings().forEach((c, i) => (c.position = i + 1));
  }

  /**
   * Distacco di c da chi lo precede in classifica (o dal leader, se toLeader).
   * Gara: secondi (o giri di distacco); prove/qualifica: differenza sul giro migliore.
   */
  gap(c: Competitor, toLeader = true): string {
    const st = this.standings();
    const i = st.indexOf(c);
    if (i <= 0) return this.isRace ? 'Leader' : c.timing.best ? '' : '–';
    const ref = toLeader ? st[0] : st[i - 1];
    if (this.isRace) {
      const lapsBehind = Math.floor((ref.timing.totalDistance - c.timing.totalDistance) / this.trackLength);
      if (lapsBehind >= 1 && !(c.finished && ref.finished && c.lapsDone === ref.lapsDone)) {
        return `+${lapsBehind} ${lapsBehind === 1 ? 'giro' : 'giri'}`;
      }
      if (c.finished && ref.finished) return `+${(c.finishTime! + c.penalty - ref.finishTime! - ref.penalty).toFixed(3)}`;
      const t = ref.timing.timeAtDistance(c.timing.totalDistance);
      if (t === null) return '';
      return `+${(c.timing.sessionTime - t).toFixed(1)}`;
    }
    if (!c.timing.best || !ref.timing.best) return '–';
    return `+${(c.timing.best.time - ref.timing.best.time).toFixed(3)}`;
  }
}
