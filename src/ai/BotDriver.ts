/**
 * PILOTA BOT: guida l'auto con gli STESSI comandi di un umano (sterzo, gas,
 * freno) sulla STESSA fisica. Nessun trucco: se sbaglia, va lungo davvero.
 *
 *  - Sterzo: "pure pursuit" — punta un punto della traiettoria ideale più
 *    avanti (più lontano quanto più va veloce), più una correzione se l'auto
 *    ruota troppo o troppo poco (controsterzo in sovrasterzo).
 *  - Velocità: segue il profilo di velocità calcolato per il suo livello,
 *    adattandolo all'aderenza che "sente" (gomme fredde o usurate → più piano).
 *  - Traffico: se c'è un'auto davanti sulla sua linea si accoda senza
 *    tamponare (sorpassi e difese: Fase 6).
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
}

/** Livelli di difficoltà */
export const DIFFICULTIES = {
  facile: { label: 'Facile', grip: 0.83, brake: 0.78, inconsistency: 0.03 },
  medio: { label: 'Medio', grip: 0.88, brake: 0.84, inconsistency: 0.02 },
  difficile: { label: 'Difficile', grip: 0.93, brake: 0.9, inconsistency: 0.012 },
  esperto: { label: 'Esperto', grip: 0.97, brake: 0.94, inconsistency: 0.006 },
} as const;
export type Difficulty = keyof typeof DIFFICULTIES;

/** Cosa sa il bot delle altre auto (posizione sulla pista e velocità). */
export interface Traffic {
  s: number;
  d: number;
  speed: number;
}

export class BotDriver {
  private profile: Float32Array;
  private steer = 0;
  /** Variazione casuale di questo giro, per ogni "zona" della pista */
  private lapNoise: Float32Array;
  private lastS = 0;
  /** Spostamento laterale per aggirare un'auto ferma o lentissima (m) */
  private avoidOffset = 0;
  /** Tempo da fermo (per capire se è bloccato) */
  stuckTime = 0;

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

  /**
   * Decide i comandi per questo passo.
   * @param s, d posizione dell'auto sulla pista
   * @param others altre auto (pilota e bot)
   * @param hold true = tieni il freno (es. prima del via)
   */
  drive(dt: number, s: number, d: number, others: Traffic[], hold: boolean): DriverInput {
    const v = this.vehicle;
    const line = this.line;
    const track = line.track;
    const n = line.n;
    const step = track.length / n;
    const idx = Math.round(s / step) % n;
    const out = emptyInput();

    // nuovo giro → nuova variabilità
    if (s < this.lastS - track.length / 2) this.newLapNoise();
    this.lastS = s;

    if (hold) {
      out.brake = 1;
      return out;
    }

    // ---------- STERZO (pure pursuit) ----------
    const speed = Math.max(v.speed, 1);
    const look = 5 + speed * 0.42; // metri
    const ti = (idx + Math.round(look / step)) % n;
    const ts = track.samples[ti];
    const tx = line.x[ti] + ts.nx * this.avoidOffset - v.x, tz = line.z[ti] + ts.nz * this.avoidOffset - v.z;
    const sinY = Math.sin(v.yaw), cosY = Math.cos(v.yaw);
    const lz = tx * sinY + tz * cosY; // avanti
    const lx = tx * cosY - tz * sinY; // sinistra
    const alpha = Math.atan2(lx, Math.max(0.1, lz));
    const ld = Math.hypot(lx, lz);
    const curv = (2 * Math.sin(alpha)) / Math.max(ld, 1);
    let delta = Math.atan(v.car.wheelbase * curv);
    // correzione imbardata: se l'auto ruota più del previsto, sterza al contrario (controsterzo)
    const yawErr = v.yawRate - speed * curv;
    delta -= 0.16 * yawErr;
    // angolo di deriva del corpo vettura: quanto l'auto "va di traverso"
    const beta = Math.atan2(v.vLat, Math.max(3, v.vLong));
    const sliding = Math.abs(beta) > 4 * RAD && v.speed > 8;
    if (sliding) delta += beta * 0.6; // controsterzo nella direzione della derapata
    // correzione laterale lenta verso la linea
    delta += clamp((line.offset[idx] + this.avoidOffset - d) * 0.004, -0.02, 0.02) * (v.speed > 5 ? 1 : 0);
    const maxDelta = ((v.car.steeringLockDeg / 2) / v.car.steeringRatio) * RAD;
    const targetSteer = clamp(delta / maxDelta, -1, 1);
    // le mani del bot non sono istantanee
    const rate = 4 * dt;
    this.steer += clamp(targetSteer - this.steer, -rate, rate);
    out.steer = this.steer;

    // ---------- VELOCITÀ ----------
    // anticipo: guardo un po' avanti (tempo di reazione + trasferimento di carico)
    const ahead = (idx + Math.round((speed * 0.22) / step)) % n;
    // aderenza percepita: gomme fredde/usurate → più prudente
    const feel = v.tires.reduce((a, t) => a + t.gripFactor, 0) / 4;
    let vt = Math.min(this.target(ahead), this.target(idx) + 3) * Math.sqrt(Math.min(1, feel / 0.98));

    // ---------- TRAFFICO: accodarsi (e aggirare chi è fermo) ----------
    const myLineD = line.offset[idx] + this.avoidOffset;
    let wantAvoid = 0;
    for (const o of others) {
      let gap = o.s - s;
      if (gap < -track.length / 2) gap += track.length;
      if (gap > track.length / 2) gap -= track.length;
      if (gap <= 0 || gap > 60 + speed * 1.2) continue;
      // è davanti a me oppure sulla traiettoria che sto per percorrere?
      if (Math.abs(o.d - d) > 2.4 && Math.abs(o.d - myLineD) > 2.4) continue;
      const safe = 5.5 + speed * 0.35;
      // auto ferma o lentissima davanti: la si aggira dal lato con più spazio
      if (o.speed < 4 && gap < 45) {
        const w = track.samples[idx].width / 2 - 1.3;
        const left = w - o.d, right = o.d + w; // spazio libero a sinistra / destra dell'ostacolo
        wantAvoid = left > right ? Math.min(w, o.d + 3) - line.offset[idx] : Math.max(-w, o.d - 3) - line.offset[idx];
        continue;
      }
      // velocità che permette di fermarsi dietro di lui
      const closing = Math.sqrt(Math.max(0, o.speed * o.speed + 2 * 7 * Math.max(0, gap - safe)));
      vt = Math.min(vt, closing, gap < safe ? o.speed * 0.9 : Infinity);
    }

    // l'aggiramento entra e esce gradualmente
    this.avoidOffset += clamp(wantAvoid - this.avoidOffset, -2 * dt, 2 * dt);
    if (Math.abs(this.avoidOffset) > 0.5) vt = Math.min(vt, 22); // passa piano accanto all'ostacolo

    const err = vt - v.speed;
    if (err > 0) {
      out.throttle = clamp(err * 0.6 + 0.15, 0, 1);
      out.brake = 0;
    } else {
      out.throttle = err > -0.8 ? clamp(0.3 + err * 0.3, 0, 1) : 0;
      out.brake = err < -0.8 ? clamp(-err * 0.35, 0, 1) : 0;
    }
    // il posteriore parte: via dal freno e gas dolce per ritrovare aderenza (come un pilota)
    if (sliding) {
      out.brake = Math.min(out.brake, 0.1);
      out.throttle = Math.min(out.throttle, 0.25);
    }

    // bloccato? (fermo per più secondi): lo segnaliamo a chi lo gestisce
    this.stuckTime = v.speed < 1.5 ? this.stuckTime + dt : 0;
    return out;
  }
}
