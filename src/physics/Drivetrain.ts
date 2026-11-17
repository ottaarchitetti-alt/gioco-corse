/**
 * Motore + cambio + differenziale (trazione posteriore).
 *
 * Il motore produce coppia secondo la curva del file auto. La coppia viene
 * moltiplicata dal rapporto della marcia e dal rapporto finale, poi divisa
 * tra le due ruote posteriori da un differenziale autobloccante semplice.
 *
 * FRIZIONE AUTOMATICA: a bassissima velocità (partenza) la frizione "slitta":
 * il motore resta su di giri e trasmette coppia senza spegnersi.
 * Quando i giri ricavati dalle ruote superano la soglia, motore e ruote
 * sono collegati rigidamente (e l'inerzia del motore si somma a quella delle ruote).
 */
import { clamp, damp, interpTable, RPM_TO_RADS } from '../core/math';
import type { CarParams } from './CarParams';

export interface DriveOutput {
  /** Coppia sulla ruota posteriore sinistra / destra (Nm), + = spinge in avanti */
  torqueRL: number;
  torqueRR: number;
  /** Inerzia del motore "vista" da ogni ruota posteriore (kg·m²), 0 se disaccoppiato */
  reflectedInertia: number;
}

export class Drivetrain {
  /** -1 = retro, 0 = folle, 1..n = marce avanti */
  gear = 1;
  rpm: number;
  /** true mentre la frizione slitta (partenza) */
  clutchSlipping = false;
  private shiftTimer = 0;
  /** Coppia motore attuale (per telemetria) */
  engineTorque = 0;
  /** Coppia trasferita dal differenziale tra le ruote posteriori (per telemetria) */
  diffTransfer = 0;

  constructor(private car: CarParams) {
    this.rpm = car.idleRpm;
  }

  get gearCount(): number {
    return this.car.gears.length;
  }

  get isShifting(): boolean {
    return this.shiftTimer > 0;
  }

  /** Rapporto totale (marcia × finale), con segno: negativo in retromarcia. */
  ratio(gear = this.gear): number {
    if (gear === 0) return 0;
    if (gear < 0) return -this.car.reverseGear * this.car.finalDrive;
    return this.car.gears[gear - 1] * this.car.finalDrive;
  }

  reset(): void {
    this.gear = 1;
    this.rpm = this.car.idleRpm;
    this.shiftTimer = 0;
  }

  /** Richiesta di cambio marcia (manuale o dal cambio automatico). */
  shift(dir: 1 | -1, wheelOmega: number, speedMs: number): void {
    const target = this.gear + dir;
    if (target > this.gearCount) return;
    if (target < -1) return;
    // Retromarcia solo da (quasi) fermi
    if (target === -1 && speedMs > 1.5) return;
    // Protezione fuorigiri in scalata: niente marcia che porterebbe oltre il limitatore
    if (dir < 0 && target > 0) {
      const predicted = Math.abs(wheelOmega * this.ratio(target)) / RPM_TO_RADS;
      if (predicted > this.car.maxRpm * 1.02) return;
    }
    this.gear = target;
    if (target !== 0) this.shiftTimer = this.car.shiftTime;
  }

  /**
   * Avanza di un passo.
   * @param omegaL, omegaR velocità angolari delle ruote posteriori (rad/s)
   */
  update(
    dt: number,
    throttle: number,
    brake: number,
    omegaL: number,
    omegaR: number,
    speedMs: number,
    autoShift: boolean,
  ): DriveOutput {
    const car = this.car;
    const wheelOmega = (omegaL + omegaR) / 2;

    if (autoShift) this.autoShift(throttle, brake, wheelOmega, speedMs);

    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    const ratio = this.ratio();
    const rpmFromWheels = (wheelOmega * ratio) / RPM_TO_RADS; // positivo se la marcia "spinge" nel verso giusto

    let engineTorque = 0;
    let coupled = false;
    this.clutchSlipping = false;

    if (this.gear === 0 || this.shiftTimer > 0) {
      // Folle o cambiata in corso: motore libero
      const freeTarget = car.idleRpm + throttle * (car.maxRpm - car.idleRpm);
      this.rpm += (freeTarget - this.rpm) * damp(this.gear === 0 ? 6 : 15, dt);
      if (this.shiftTimer > 0 && this.gear !== 0) {
        // durante la cambiata i giri si allineano alla nuova marcia
        this.rpm += (Math.max(rpmFromWheels, car.idleRpm) - this.rpm) * damp(40, dt);
      }
    } else {
      const clutchRpm = car.idleRpm + 500;
      if (rpmFromWheels < clutchRpm) {
        // Partenza: la frizione slitta. Il motore sale di giri con l'acceleratore.
        this.clutchSlipping = true;
        const launchRpm = Math.max(rpmFromWheels, car.idleRpm + throttle * 3000);
        this.rpm += (launchRpm - this.rpm) * damp(10, dt);
        engineTorque = throttle * interpTable(car.torqueCurve, this.rpm);
      } else {
        coupled = true;
        this.rpm = rpmFromWheels;
        engineTorque =
          throttle * interpTable(car.torqueCurve, this.rpm) -
          (1 - throttle) * interpTable(car.engineBrakeCurve, this.rpm);
        // Limitatore: taglia la coppia positiva oltre il regime massimo
        if (this.rpm >= car.maxRpm) engineTorque = Math.min(engineTorque, 0);
      }
    }
    this.rpm = clamp(this.rpm, car.idleRpm * 0.9, car.maxRpm * 1.1);
    this.engineTorque = engineTorque;

    // Coppia all'assale posteriore
    const axleTorque = engineTorque * ratio * car.drivetrainEfficiency;

    // ---- Differenziale autobloccante a rampe (a frizioni) ----
    // Le frizioni possono trasferire al massimo "lockCap" Nm dalla ruota più veloce alla più lenta:
    //   lockCap = precarico + rampa × coppia in ingresso
    // con rampa diversa in trazione (power) e in rilascio (coast). Più bloccaggio in trazione =
    // più motricità in uscita ma più sottosterzo; in rilascio = più stabilità in inserimento.
    const reflectedInertia = coupled ? (car.engineInertia * ratio * ratio) / 2 : 0;
    const dOmega = omegaL - omegaR;
    const ramp = axleTorque >= 0 ? car.diffPowerLock : car.diffCoastLock;
    const lockCap = car.diffPreload + ramp * Math.abs(axleTorque);
    // Coppia che basterebbe ad annullare la differenza in questo passo (frizioni "incollate")
    const toLock = (Math.abs(dOmega) * (car.wheelInertia + reflectedInertia)) / (2 * dt);
    const transfer = Math.sign(dOmega) * Math.min(lockCap, toLock * 0.8);
    this.diffTransfer = transfer;
    return {
      torqueRL: axleTorque / 2 - transfer,
      torqueRR: axleTorque / 2 + transfer,
      reflectedInertia,
    };
  }

  /** Cambio automatico semplice, pensato per la pista (tiene il motore in coppia). */
  private autoShift(throttle: number, brake: number, wheelOmega: number, speedMs: number): void {
    const car = this.car;
    if (this.shiftTimer > 0) return;
    if (this.gear === 0 && throttle > 0.1) {
      this.gear = 1;
      return;
    }
    if (this.gear < 1) return; // in retro si cambia solo a mano
    if (this.gear < this.gearCount && this.rpm > car.maxRpm * 0.97 && !this.clutchSlipping) {
      this.shift(1, wheelOmega, speedMs);
      return;
    }
    if (this.gear > 1) {
      const lowerRpm = Math.abs(wheelOmega * this.ratio(this.gear - 1)) / RPM_TO_RADS;
      const threshold = brake > 0.1 ? 0.66 : 0.45;
      if (this.rpm < car.maxRpm * threshold && lowerRpm < car.maxRpm * 0.92) {
        this.shift(-1, wheelOmega, speedMs);
      }
    }
  }
}
