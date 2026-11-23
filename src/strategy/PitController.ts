/**
 * PILOTA AUTOMATICO DELLA CORSIA BOX (per il pilota e per i bot).
 *
 * Quando un'auto entra in corsia box ci pensa lui, come nei simulatori:
 *   ingresso  → segue la corsia e rallenta fino al limite prima della linea del limitatore
 *   verso piazzola → a velocità limitata fino alla propria piazzola, si ferma
 *   sosta     → i meccanici lavorano (cambio gomme, rifornimento): durata realistica
 *   uscita    → riparte con il limitatore, poi accelera fino al rientro in pista
 * Il tempo passato in corsia (ingresso, sosta, uscita) conta nel tempo sul giro,
 * esattamente come nella realtà.
 */
import type { CarParams } from '../physics/CarParams';
import { clamp, RAD } from '../core/math';
import { emptyInput, type DriverInput } from '../input/InputManager';
import type { Vehicle } from '../physics/Vehicle';
import type { PitLaneSpline, PitStall } from '../track/TrackSpline';

export type PitPhase = 'ingresso' | 'verso piazzola' | 'sosta' | 'uscita' | 'finito';

/** Cosa fare al pit stop */
export interface PitPlan {
  changeTyres: boolean;
  compound: string;
  /** kg di carburante da aggiungere */
  addFuel: number;
  /** cambio dell'ala anteriore danneggiata (e riparazioni rapide): +6 s */
  repair?: boolean;
}

/** Durata della sosta (s): sollevamento + max(cambio gomme, rifornimento) — si fanno insieme. */
/** Durata della sosta: tempo fisso + il più lungo tra cambio gomme e rifornimento (GT: 4 + 13 s; monoposto ~2+2,4 s). */
export function serviceTime(plan: PitPlan, car?: CarParams): number {
  const p = car?.pit ?? { fixedTime: 4, tyreChangeTime: 13, refuel: true };
  const tyres = plan.changeTyres ? p.tyreChangeTime : 0;
  const fuel = p.refuel ? plan.addFuel / 2.5 : 0; // 2,5 kg al secondo
  return p.fixedTime + Math.max(tyres, fuel) + (plan.repair ? 6 : 0);
}

export class PitController {
  phase: PitPhase;
  /** secondi di sosta rimasti */
  serviceLeft = 0;
  serviceTotal = 0;
  private hint = -1;
  private steer = 0;
  /** posizione nella corsia (per HUD e test) */
  s = 0;
  d = 0;

  constructor(
    private pit: PitLaneSpline,
    private stall: PitStall,
    private vehicle: Vehicle,
    readonly plan: PitPlan,
    /** chiamato a fine sosta per applicare gomme e benzina */
    private onService: (plan: PitPlan) => void,
    startPhase: PitPhase = 'ingresso',
  ) {
    this.phase = startPhase;
  }

  get limit(): number {
    return this.pit.data.speedLimitKmh / 3.6;
  }

  /** true se l'auto è nel tratto con il limitatore */
  get inLimiterZone(): boolean {
    return this.s >= this.pit.limiterStart - 2 && this.s <= this.pit.limiterEnd;
  }

  /** Comandi per questo passo; null = finito (si torna a guidare normalmente). */
  drive(dt: number): DriverInput | null {
    const v = this.vehicle;
    const pit = this.pit;
    const q = pit.project(v.x, v.z, this.hint);
    this.hint = q.index;
    this.s = q.s;
    this.d = q.d;
    const out = emptyInput();
    v.speedLimiter = this.inLimiterZone && this.phase !== 'sosta' ? this.limit : 0;

    // finito: uscito dalla corsia
    if (this.phase === 'uscita' && q.s > pit.length - 4) {
      this.phase = 'finito';
      v.speedLimiter = 0;
      return null;
    }
    // persa la corsia (es. urto): si rinuncia
    if (Math.abs(q.d) > pit.data.width / 2 + 12) {
      this.phase = 'finito';
      v.speedLimiter = 0;
      return null;
    }

    if (this.phase === 'sosta') {
      out.brake = 1;
      this.serviceLeft -= dt;
      if (this.serviceLeft <= 0) {
        this.onService(this.plan);
        this.phase = 'uscita';
      }
      return out;
    }

    // ---- velocità obiettivo ----
    let vt: number;
    const lim = this.limit;
    if (q.s < pit.limiterStart) {
      // frena per arrivare alla linea del limitatore già al limite
      vt = Math.sqrt(lim * lim + 2 * 6 * Math.max(0, pit.limiterStart - q.s - 3));
    } else if (q.s <= pit.limiterEnd) vt = lim * 0.97;
    else vt = 40;
    if (this.phase === 'ingresso' && q.s >= pit.limiterStart) this.phase = 'verso piazzola';
    let lat = 0;
    if (this.phase === 'verso piazzola') {
      const toStall = this.stall.s - q.s;
      vt = Math.min(vt, Math.sqrt(2 * 4 * Math.max(0, toStall - 0.3)));
      // nell'ultimo tratto ci si sposta verso la piazzola (lato box)
      const stallLat = (this.stall.x - pit.atS(this.stall.s).x) * pit.atS(this.stall.s).nx + (this.stall.z - pit.atS(this.stall.s).z) * pit.atS(this.stall.s).nz;
      lat = stallLat * clamp(1 - (toStall - 5) / 30, 0, 1);
      if (toStall < 1.5 && v.speed < 1.2) {
        this.phase = 'sosta';
        this.serviceTotal = this.serviceLeft = serviceTime(this.plan, this.vehicle.car);
        out.brake = 1;
        return out;
      }
      if (toStall < -6) this.phase = 'uscita'; // l'ha mancata: niente sosta
    }

    // ---- sterzo: insegue un punto della corsia più avanti ----
    const speed = Math.max(v.speed, 1);
    const look = 4 + speed * 0.4;
    const t = pit.atS(Math.max(0, q.s) + look);
    const tx = t.x + t.nx * lat - v.x, tz = t.z + t.nz * lat - v.z;
    const sinY = Math.sin(v.yaw), cosY = Math.cos(v.yaw);
    const lz = tx * sinY + tz * cosY, lx = tx * cosY - tz * sinY;
    const alpha = Math.atan2(lx, Math.max(0.1, lz));
    const curv = (2 * Math.sin(alpha)) / Math.max(Math.hypot(lx, lz), 1);
    let delta = Math.atan(v.car.wheelbase * curv);
    delta -= 0.12 * (v.yawRate - speed * curv);
    const maxDelta = ((v.car.steeringLockDeg / 2) / v.car.steeringRatio) * RAD;
    this.steer += clamp(clamp(delta / maxDelta, -1, 1) - this.steer, -4 * dt, 4 * dt);
    out.steer = this.steer;

    const err = vt - v.speed;
    if (err > 0) out.throttle = clamp(err * 0.5 + 0.1, 0, 1);
    else out.brake = clamp(-err * 0.4, 0, 1);
    return out;
  }
}
