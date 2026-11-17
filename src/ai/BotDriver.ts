/**
 * PILOTA BOT: guida l'auto con gli STESSI comandi di un umano (sterzo, gas,
 * freno) sulla STESSA fisica. Nessun trucco: se sbaglia, va lungo davvero.
 *
 *  - Sterzo: "pure pursuit" — punta un punto della traiettoria (ideale, o
 *    spostata di lato per sorpassare/difendersi) più avanti, più controsterzo
 *    se l'auto ruota troppo.
 *  - Velocità: segue il profilo di velocità del suo livello, adattato
 *    all'aderenza che "sente" (gomme fredde o usurate → più piano).
 *
 *  CORPO A CORPO (Fase 6)
 *  - Accodamento: non tampona chi gli sta davanti.
 *  - Sorpasso: se è più veloce o bloccato da un po', sceglie il lato con più
 *    spazio (preferendo l'interno della prossima curva), sfrutta la scia e
 *    stacca un filo più tardi; se affiancato lascia spazio; poi rientra.
 *  - Difesa: UNA sola cambiata di traiettoria per coprire l'interno quando
 *    qualcuno lo attacca prima di una curva.
 *  - Bandiere: con la blu (sta per essere doppiato) si sposta e alza il piede;
 *    con la gialla (auto ferma o fuori più avanti) rallenta.
 *
 *  ERRORI (Fase 6)
 *  All'inizio di ogni frenata può sbagliare: frenata lunga, bloccaggio delle
 *  ruote, troppo gas in uscita. Più probabile ai livelli bassi, sotto
 *  pressione, durante un sorpasso, con gomme usurate.
 */
import { clamp, RAD } from '../core/math';
import { emptyInput, type DriverInput } from '../input/InputManager';
import type { Vehicle } from '../physics/Vehicle';
import type { RacingLine } from './RacingLine';

export interface BotSkill {
  /** Frazione dell'aderenza teorica sfruttata */
  grip: number;
  /** Frazione della decelerazione massima usata in frenata */
  brake: number;
  /** Variabilità da un giro all'altro (0 = robot perfetto) */
  inconsistency: number;
  /** Probabilità di errore a ogni frenata (prima dei moltiplicatori) */
  errorRate: number;
  /** Voglia di sorpassare (0..1) */
  aggression: number;
}

/** Livelli di difficoltà */
export const DIFFICULTIES = {
  facile: { label: 'Facile', grip: 0.83, brake: 0.78, inconsistency: 0.03, errorRate: 0.05, aggression: 0.4 },
  medio: { label: 'Medio', grip: 0.88, brake: 0.84, inconsistency: 0.02, errorRate: 0.03, aggression: 0.6 },
  difficile: { label: 'Difficile', grip: 0.93, brake: 0.9, inconsistency: 0.012, errorRate: 0.015, aggression: 0.75 },
  esperto: { label: 'Esperto', grip: 0.97, brake: 0.94, inconsistency: 0.006, errorRate: 0.007, aggression: 0.9 },
} as const;
export type Difficulty = keyof typeof DIFFICULTIES;

/** Cosa sa il bot delle altre auto. */
export interface Traffic {
  /** posizione sulla pista */
  s: number;
  d: number;
  speed: number;
  /** distanza totale percorsa nella sessione (per capire chi è un giro avanti) */
  total: number;
  /** fuori pista (almeno 2 ruote sull'erba) */
  offTrack: boolean;
}

type Mode = 'linea' | 'sorpasso' | 'difesa' | 'cede';
type ErrorType = 'lungo' | 'bloccaggio' | 'gas';

/** Larghezza "di sicurezza" tra due auto affiancate (centro-centro, m) */
const SIDE_GAP = 2.7;

export class BotDriver {
  private profile: Float32Array;
  private steer = 0;
  /** Variazione casuale di questo giro, per ogni "zona" della pista */
  private lapNoise: Float32Array;
  private lastS = 0;
  /** Spostamento laterale dalla traiettoria ideale, attuale e desiderato (m) */
  private lane = 0;
  mode: Mode = 'linea';
  private passSide = 0;
  private passTarget: Traffic | null = null;
  private modeTimer = 0;
  /** Tempo passato dietro la stessa auto */
  private followTime = 0;
  private defendUsed = false;
  private defendSide = 0;
  // errori
  private wasBraking = false;
  private errType: ErrorType | null = null;
  private errTimer = 0;
  /** Disattiva l'ABS (bloccaggio): lo legge chi applica gli aiuti */
  absOff = false;
  /** Ultimo errore commesso (per messaggi e test) */
  lastError = '';
  errors = 0;
  /** Tempo da fermo (per capire se è bloccato) */
  stuckTime = 0;
  /** Bandiere viste in questo passo */
  flags = { yellow: false, blue: false };

  constructor(private line: RacingLine, private vehicle: Vehicle, readonly skill: BotSkill) {
    this.profile = line.speedProfile(vehicle.car, skill.grip, skill.brake);
    this.lapNoise = new Float32Array(32);
    this.newLapNoise();
  }

  private newLapNoise(): void {
    for (let i = 0; i < this.lapNoise.length; i++) this.lapNoise[i] = 1 - Math.random() * this.skill.inconsistency;
  }

  /** Velocità obiettivo all'indice i, con rumore del giro. */
  private target(i: number): number {
    const n = this.line.n;
    const k = ((i % n) + n) % n;
    return this.profile[k] * this.lapNoise[Math.floor((k / n) * this.lapNoise.length)];
  }

  /** Lato interno della prossima curva importante entro `dist` metri: +1 sinistra, −1 destra, 0 nessuna. */
  private nextCornerSide(idx: number, dist: number): number {
    const n = this.line.n, step = this.line.track.length / n;
    let best = 0, sign = 0;
    for (let k = 0; k < dist / step; k += 2) {
      const c = this.line.curvature[(idx + k) % n];
      if (Math.abs(c) > best) { best = Math.abs(c); sign = Math.sign(c); }
    }
    return best > 1 / 400 ? sign : 0;
  }

  /**
   * Decide i comandi per questo passo.
   * @param s, d posizione dell'auto sulla pista
   * @param myTotal distanza totale percorsa nella sessione
   * @param others altre auto (pilota e bot)
   * @param hold true = tieni il freno (es. prima del via)
   */
  drive(dt: number, s: number, d: number, myTotal: number, others: Traffic[], hold: boolean): DriverInput {
    const v = this.vehicle;
    const line = this.line;
    const track = line.track;
    const n = line.n;
    const L = track.length;
    const step = L / n;
    const idx = Math.round(s / step) % n;
    const out = emptyInput();
    this.absOff = false;

    // nuovo giro → nuova variabilità
    if (s < this.lastS - L / 2) this.newLapNoise();
    this.lastS = s;

    if (hold) {
      out.brake = 1;
      return out;
    }
    const speed = Math.max(v.speed, 1);
    const halfW = track.samples[idx].width / 2 - 1.2; // dove può stare il centro dell'auto
    const lineD = line.offset[idx];

    // =================== LETTURA DEL TRAFFICO ===================
    let front: (Traffic & { gap: number }) | null = null; // la prima auto davanti sulla mia traiettoria
    let attacker: (Traffic & { gap: number }) | null = null; // chi mi attacca da dietro
    let minD = -halfW, maxD = halfW; // limiti laterali per non stringere chi è affiancato
    let wantAvoid: number | null = null;
    const myLane = lineD + this.lane;
    this.flags = { yellow: false, blue: false };
    let blueFrom = 0;

    for (const o of others) {
      let gap = o.s - s;
      if (gap < -L / 2) gap += L;
      if (gap > L / 2) gap -= L;

      // bandiera gialla: auto ferma o fuori pista più avanti
      if (gap > 0 && gap < 250 && (o.offTrack || o.speed < 8)) this.flags.yellow = true;
      // bandiera blu: arriva da dietro chi è un giro avanti
      if (gap < 0 && gap > -70 && o.total > myTotal + L * 0.5) {
        this.flags.blue = true;
        blueFrom = o.d;
      }

      // affiancati: lascio spazio
      if (Math.abs(gap) < 5.5) {
        if (o.d > d) maxD = Math.min(maxD, o.d - SIDE_GAP);
        else minD = Math.max(minD, o.d + SIDE_GAP);
        continue;
      }
      // dietro: possibile attaccante
      if (gap < 0) {
        if (gap > -18 && o.speed > v.speed - 1 && (!attacker || gap > attacker.gap)) attacker = { ...o, gap };
        continue;
      }
      if (gap > 60 + speed * 1.2) continue;
      // è sulla mia traiettoria? (in sorpasso conta solo dove sono adesso, non dove andrò)
      const inPath = Math.abs(o.d - d) <= 2.3 || (this.mode !== 'sorpasso' && Math.abs(o.d - myLane) <= 2.3);
      if (!inPath) continue;
      // auto ferma o lentissima: si aggira dal lato con più spazio
      if (o.speed < 4 && gap < 45) {
        const left = halfW - o.d, right = o.d + halfW;
        wantAvoid = left > right ? Math.min(halfW, o.d + 3.2) : Math.max(-halfW, o.d - 3.2);
        continue;
      }
      if (!front || gap < front.gap) front = { ...o, gap };
    }

    // =================== DECISIONI ===================
    this.modeTimer += dt;
    let laneAbs = lineD; // posizione laterale desiderata (assoluta)
    if (front && front.gap < 30) this.followTime += dt;
    else this.followTime = 0;

    if (this.flags.blue) {
      // lascia passare: verso il lato opposto a chi arriva
      this.mode = 'cede';
      laneAbs = clamp(blueFrom >= d ? d - SIDE_GAP : d + SIDE_GAP, -halfW, halfW);
    } else {
      if (this.mode === 'cede') this.mode = 'linea';

      // ---- inizio sorpasso ----
      if (this.mode !== 'sorpasso' && front && front.gap < 28) {
        const faster = v.speed > front.speed + 1.5 || this.target(idx) > front.speed + 2.5;
        const stuck = this.followTime > 3 - this.skill.aggression * 1.5;
        if ((faster || stuck) && Math.random() < 0.2 + this.skill.aggression * 0.5) {
          const inside = this.nextCornerSide(idx, 220);
          const roomL = halfW - (front.d + SIDE_GAP), roomR = (front.d - SIDE_GAP) + halfW;
          let side = 0;
          if (inside !== 0 && (inside > 0 ? roomL : roomR) >= 0) side = inside;
          else if (roomL >= 0 || roomR >= 0) side = roomL > roomR ? 1 : -1;
          if (side !== 0) {
            this.mode = 'sorpasso';
            this.passSide = side;
            this.passTarget = front;
            this.modeTimer = 0;
          }
        }
      }

      if (this.mode === 'sorpasso') {
        // ritrova l'auto da passare (la più vicina con stessa posizione approssimata)
        let tgt: (Traffic & { gap: number }) | null = null;
        for (const o of others) {
          let gap = o.s - s;
          if (gap < -L / 2) gap += L;
          if (gap > L / 2) gap -= L;
          if (gap > -15 && gap < 40 && (!tgt || Math.abs(o.d - this.passTarget!.d) < Math.abs(tgt.d - this.passTarget!.d))) tgt = { ...o, gap };
        }
        if (!tgt || tgt.gap < -9 || this.modeTimer > 9) {
          // lo sorpassato non è più tra i "vicini": si rientra solo se la linea è libera
          this.mode = 'linea'; // passato (o rinuncia): si rientra in traiettoria
          this.passTarget = null;
        } else {
          this.passTarget = tgt;
          laneAbs = clamp(tgt.d + this.passSide * (SIDE_GAP + 0.4), -halfW, halfW);
          // non c'è più spazio da quel lato: rinuncia
          if (Math.abs(laneAbs - tgt.d) < SIDE_GAP - 0.3) this.mode = 'linea';
        }
      } else if (this.mode === 'difesa') {
        laneAbs = clamp(lineD + this.defendSide * 2.6, -halfW, halfW);
        if (this.modeTimer > 4 || !attacker) this.mode = 'linea';
      } else {
        // ---- difesa: una sola mossa per coprire l'interno ----
        if (attacker && !this.defendUsed && Math.abs(attacker.d - d) > 1.2 && attacker.gap > -14) {
          const inside = this.nextCornerSide(idx, 160);
          const attackSide = Math.sign(attacker.d - d);
          if (inside !== 0 && attackSide === inside && Math.random() < this.skill.aggression * 0.05) {
            this.mode = 'difesa';
            this.defendSide = inside;
            this.defendUsed = true;
            this.modeTimer = 0;
          }
        }
      }
      if (!attacker || attacker.gap < -30) this.defendUsed = false;
    }

    if (wantAvoid !== null) laneAbs = wantAvoid;
    laneAbs = clamp(laneAbs, minD, Math.max(minD, maxD));
    // la traiettoria cambia gradualmente (3 m/s di spostamento laterale)
    this.lane += clamp(laneAbs - lineD - this.lane, -3 * dt, 3 * dt);
    if (this.mode === 'linea' && wantAvoid === null) this.lane += clamp(-this.lane, -1.5 * dt, 1.5 * dt);

    // =================== STERZO (pure pursuit) ===================
    const look = 5 + speed * 0.42; // metri
    const ti = (idx + Math.round(look / step)) % n;
    const ts = track.samples[ti];
    // il punto mirato resta dentro la carreggiata anche se lì la traiettoria è già vicina al bordo
    const tHalf = ts.width / 2 - 1.2;
    const tLat = clamp(line.offset[ti] + this.lane, -tHalf, tHalf);
    const tx = ts.x + ts.nx * tLat - v.x, tz = ts.z + ts.nz * tLat - v.z;
    const sinY = Math.sin(v.yaw), cosY = Math.cos(v.yaw);
    const lz = tx * sinY + tz * cosY; // avanti
    const lx = tx * cosY - tz * sinY; // sinistra
    const alpha = Math.atan2(lx, Math.max(0.1, lz));
    const ld = Math.hypot(lx, lz);
    const curv = (2 * Math.sin(alpha)) / Math.max(ld, 1);
    let delta = Math.atan(v.car.wheelbase * curv);
    const yawErr = v.yawRate - speed * curv;
    delta -= 0.16 * yawErr; // l'auto ruota più del previsto → controsterzo
    const beta = Math.atan2(v.vLat, Math.max(3, v.vLong));
    const sliding = Math.abs(beta) > 4 * RAD && v.speed > 8;
    if (sliding) delta += beta * 0.6;
    delta += clamp((clamp(lineD + this.lane, -halfW, halfW) - d) * 0.004, -0.02, 0.02) * (v.speed > 5 ? 1 : 0);
    const maxDelta = ((v.car.steeringLockDeg / 2) / v.car.steeringRatio) * RAD;
    const rate = 4 * dt;
    this.steer += clamp(clamp(delta / maxDelta, -1, 1) - this.steer, -rate, rate);
    out.steer = this.steer;

    // =================== VELOCITÀ ===================
    const ahead = (idx + Math.round((speed * 0.22) / step)) % n;
    const feel = v.tires.reduce((a, t) => a + t.gripFactor, 0) / 4;
    let vt = Math.min(this.target(ahead), this.target(idx) + 3) * Math.sqrt(Math.min(1, feel / 0.98));
    // fuori traiettoria in curva il raggio è più stretto → più piano
    const k = Math.abs(line.curvature[ahead]);
    vt *= 1 - 0.06 * Math.min(1, Math.abs(this.lane) / 3) * Math.min(1, k * 120);
    // in sorpasso si stacca un filo più tardi (e si rischia di più)
    if (this.mode === 'sorpasso') vt *= 1 + 0.02 * this.skill.aggression;
    if (this.flags.yellow) vt *= 0.93;
    if (this.flags.blue) vt *= 0.95;
    if (wantAvoid !== null) vt = Math.min(vt, 22);

    // accodamento: velocità che permette di fermarsi dietro chi è davanti
    if (front && wantAvoid === null) {
      const safe = 5.5 + speed * 0.35;
      const closing = Math.sqrt(Math.max(0, front.speed * front.speed + 2 * 7 * Math.max(0, front.gap - safe)));
      vt = Math.min(vt, closing, front.gap < safe ? front.speed * 0.9 : Infinity);
    }

    // =================== ERRORI ===================
    // inizio di una frenata: la velocità obiettivo 50 m più avanti è nettamente più bassa
    const braking = this.target(idx + Math.round(50 / step)) < v.speed * 0.88;
    if (braking && !this.wasBraking && this.errType === null) this.rollError(attacker !== null);
    this.wasBraking = braking;
    if (this.errType === 'lungo') vt *= 1.09; // ha frenato tardi: entra troppo forte

    const err = vt - v.speed;
    if (err > 0) {
      out.throttle = clamp(err * 0.6 + 0.15, 0, 1);
      out.brake = 0;
    } else {
      out.throttle = err > -0.8 ? clamp(0.3 + err * 0.3, 0, 1) : 0;
      out.brake = err < -0.8 ? clamp(-err * 0.35, 0, 1) : 0;
    }
    if (this.errType === 'bloccaggio') {
      // pestone sul freno senza ABS: le ruote si bloccano, l'auto non curva
      out.brake = 1;
      out.throttle = 0;
      this.absOff = true;
    }
    if (this.errType === 'gas' && !braking) out.throttle = 1; // troppo gas in uscita
    if (this.errType !== null) {
      this.errTimer -= dt;
      if (this.errTimer <= 0) this.errType = null;
    }

    // il posteriore parte: via dal freno e gas dolce per ritrovare aderenza (come un pilota)
    if (sliding) {
      out.brake = Math.min(out.brake, 0.1);
      out.throttle = Math.min(out.throttle, 0.25);
    }

    this.stuckTime = v.speed < 1.5 ? this.stuckTime + dt : 0;
    return out;
  }

  /** Tira i dadi all'inizio di una frenata. */
  private rollError(underPressure: boolean): void {
    const tread = this.vehicle.tires.reduce((a, t) => a + t.tread, 0) / 4;
    let p = this.skill.errorRate;
    if (underPressure) p *= 2;
    if (this.mode === 'sorpasso') p *= 1.5;
    p *= 1 + 2 * (1 - tread);
    if (Math.random() >= p) return;
    const r = Math.random();
    this.errType = r < 0.45 ? 'lungo' : r < 0.75 ? 'bloccaggio' : 'gas';
    this.errTimer = this.errType === 'lungo' ? 2.2 : this.errType === 'bloccaggio' ? 0.45 : 3.0;
    this.lastError = { lungo: 'frenata lunga', bloccaggio: 'bloccaggio', gas: 'troppo gas in uscita' }[this.errType];
    this.errors++;
  }
}
