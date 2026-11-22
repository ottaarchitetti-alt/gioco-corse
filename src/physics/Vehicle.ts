/**
 * Il veicolo: corpo rigido che si muove sul piano (pista piatta) con 3 gradi
 * di libertà (x, z, imbardata), una carrozzeria sospesa (scuotimento,
 * beccheggio, rollio: vedi Suspension.ts) e 4 ruote indipendenti.
 *
 * SISTEMI DI RIFERIMENTO (uguali a Three.js e alla convenzione dei modelli Blender)
 *   Mondo: Y in alto, la pista sta sul piano XZ.
 *   Auto:  "avanti" = +Z locale, "sinistra" = +X locale.
 *   yaw:   rotazione attorno a Y; yaw positivo = l'auto gira a SINISTRA.
 *
 * A ogni passo:
 *   1. cosa c'è sotto ogni ruota (asfalto/cordolo/erba e altezza);
 *   2. le sospensioni danno il carico su ogni gomma;
 *   3. motore e cambio danno la coppia alle ruote posteriori;
 *   4. ogni gomma, da velocità, carico e temperatura, produce forze;
 *   5. forze e momenti → accelerazioni → nuove velocità e posizione;
 *   6. le accelerazioni muovono la carrozzeria sulle sospensioni (trasferimento di carico).
 *
 * Sottosterzo e sovrasterzo NON sono programmati: emergono da come carico e
 * aderenza si distribuiscono tra anteriore e posteriore.
 */
import { clamp, damp, RAD, RPM_TO_RADS } from '../core/math';
import type { DriverInput } from '../input/InputManager';
import { AIR_DENSITY } from './Aero';
import { HybridSystem } from './Hybrid';
import type { CarParams } from './CarParams';
import { Drivetrain } from './Drivetrain';
import { Suspension } from './Suspension';
import { Tire, type TireEnvironment } from './Tire';

/** Indici delle ruote */
export const FL = 0, FR = 1, RL = 2, RR = 3;
export const WHEEL_NAMES = ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'] as const;

/** Superficie sotto una ruota (fornita dalla pista). */
export interface Surface {
  name: 'asfalto' | 'cordolo' | 'erba';
  grip: number;
  /** Resistenza al rotolamento aggiuntiva (frazione del carico). */
  drag: number;
}
/** Cosa trova una ruota a terra: tipo di superficie e altezza del suolo (m). */
export interface GroundContact {
  surface: Surface;
  height: number;
}
export type GroundQuery = (wheelIndex: number, x: number, z: number) => GroundContact;

/** Aiuti alla guida (D10: tutti attivabili/disattivabili). */
export interface DrivingAids {
  abs: boolean;
  tc: boolean;
  autoShift: boolean;
  keyboardSteerAssist: boolean;
}

export class Vehicle {
  // --- Stato del corpo (mondo) ---
  x = 0;
  z = 0;
  yaw = 0;
  vx = 0;
  vz = 0;
  yawRate = 0;
  /** Stato al passo precedente, per l'interpolazione grafica. */
  prevX = 0;
  prevZ = 0;
  prevYaw = 0;

  // --- Derivati utili (aggiornati a ogni passo) ---
  speed = 0;
  /** Velocità nel riferimento auto: longitudinale (+avanti) e laterale (+sinistra). */
  vLong = 0;
  vLat = 0;
  /** Accelerazioni del passo corrente (m/s²) nel riferimento auto. */
  aLong = 0;
  aLat = 0;
  /** Accelerazioni filtrate, più leggibili per HUD e telemetria. */
  aLongSmooth = 0;
  aLatSmooth = 0;
  /** Angolo di sterzo delle ruote anteriori (rad, + = sinistra). */
  steerAngle = 0;
  /** Angolo del volante in gradi (per la grafica dell'abitacolo). */
  steeringWheelDeg = 0;

  readonly tires: Tire[];
  readonly drivetrain: Drivetrain;
  readonly suspension: Suspension;
  /** Posizione delle ruote rispetto al baricentro: [laterale(+sx), longitudinale(+avanti)] */
  readonly wheelPos: [number, number][];
  /** Distanza baricentro → asse anteriore / posteriore */
  readonly cgToFront: number;
  readonly cgToRear: number;
  /** Superficie e altezza del suolo sotto ogni ruota. */
  readonly surfaces: Surface[] = [];
  readonly roadHeight = [0, 0, 0, 0];
  /** Ultimi input applicati (dopo gli aiuti), per HUD e audio. */
  appliedThrottle = 0;
  appliedBrake = 0;
  absActive = false;
  tcActive = false;

  /**
   * SCIA: dietro un'altra auto l'aria è già "aperta" → meno resistenza (più velocità
   * in rettilineo) ma anche meno deportanza ("aria sporca" → meno aderenza in curva).
   * 1 = aria libera. Li calcola Game in base alle auto vicine.
   */
  dragFactor = 1;
  downforceFactor = 1;

  /** Condizioni ambientali (aria, asfalto, moltiplicatore usura): le imposta Game. */
  env: TireEnvironment = { airTemp: 22, trackTemp: 30, wearMultiplier: 1, fuelMultiplier: 1 };

  /** Carburante a bordo (kg): ogni auto ha il suo (il peso cala mentre consuma) */
  fuel: number;
  /** Carburante consumato dall'inizio (kg), per stimare il consumo al giro */
  fuelUsed = 0;
  /** Limitatore di velocità della corsia box (m/s), 0 = spento */
  speedLimiter = 0;

  /** Monoposto 2026: aerodinamica attiva, effetto suolo, batteria (per le GT non fa nulla) */
  readonly hybrid: HybridSystem;
  /** Deportanza totale dell'ultimo passo (N), per telemetria */
  downforceN = 0;

  private tcCut = 0;
  private loads = [0, 0, 0, 0];

  constructor(public car: CarParams, private groundQuery: GroundQuery) {
    this.tires = [0, 1, 2, 3].map(() => new Tire(car.tire, car.setup.compound));
    this.drivetrain = new Drivetrain(car);
    this.hybrid = new HybridSystem(car);
    this.fuel = car.fuelKg;
    this.cgToFront = car.wheelbase * (1 - car.weightFront);
    this.cgToRear = car.wheelbase * car.weightFront;
    const tf = car.trackFront / 2, tr = car.trackRear / 2;
    this.wheelPos = [
      [tf, this.cgToFront],
      [-tf, this.cgToFront],
      [tr, -this.cgToRear],
      [-tr, -this.cgToRear],
    ];
    this.suspension = new Suspension(car, this.wheelPos, this.cgToFront, this.cgToRear);
    const def: Surface = { name: 'asfalto', grip: 1, drag: 0 };
    for (let i = 0; i < 4; i++) this.surfaces.push(def);
    this.fitTyres(car.setup.compound, car.setup.pressureFront, car.setup.pressureRear, this.env.airTemp);
  }

  get totalMass(): number {
    return this.car.mass + this.fuel;
  }

  /** Riporta l'auto ferma in una posizione (gomme: temperatura e usura restano). */
  reset(x: number, z: number, yaw: number): void {
    this.x = this.prevX = x;
    this.z = this.prevZ = z;
    this.yaw = this.prevYaw = yaw;
    this.vx = this.vz = this.yawRate = 0;
    this.speed = this.vLong = this.vLat = 0;
    this.aLong = this.aLat = this.aLongSmooth = this.aLatSmooth = 0;
    this.tires.forEach((t) => t.resetMotion());
    this.suspension.reset();
    this.drivetrain.reset();
    this.hybrid.reset();
  }

  /** Monta 4 gomme nuove. */
  fitTyres(compound: string, pressureFront: number, pressureRear: number, startTemp: number): void {
    this.tires.forEach((t, i) => t.fitNew(compound, i < 2 ? pressureFront : pressureRear, startTemp, this.env));
  }

  /** Avanza la simulazione di `dt` secondi. */
  step(dt: number, input: DriverInput, aids: DrivingAids): void {
    const car = this.car;
    const m = this.totalMass;
    this.prevX = this.x;
    this.prevZ = this.z;
    this.prevYaw = this.yaw;

    // Assi dell'auto nel mondo
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    const fwdX = sinY, fwdZ = cosY; // avanti
    const leftX = cosY, leftZ = -sinY; // sinistra

    this.vLong = this.vx * fwdX + this.vz * fwdZ;
    this.vLat = this.vx * leftX + this.vz * leftZ;
    this.speed = Math.hypot(this.vx, this.vz);

    // ---------- Sterzo ----------
    this.steeringWheelDeg = input.steer * (car.steeringLockDeg / 2);
    this.steerAngle = (this.steeringWheelDeg / car.steeringRatio) * RAD;

    // ---------- Cambio ----------
    const avgRearOmega = (this.tires[RL].omega + this.tires[RR].omega) / 2;
    if (input.shiftUp) this.drivetrain.shift(1, avgRearOmega, this.speed);
    if (input.shiftDown) this.drivetrain.shift(-1, avgRearOmega, this.speed);

    // ---------- Cosa c'è sotto le ruote ----------
    for (let i = 0; i < 4; i++) {
      const [pLat, pLong] = this.wheelPos[i];
      const g = this.groundQuery(i, this.x + fwdX * pLong + leftX * pLat, this.z + fwdZ * pLong + leftZ * pLat);
      this.surfaces[i] = g.surface;
      this.roadHeight[i] = g.height;
    }

    // ---------- Carichi verticali dalle sospensioni ----------
    this.suspension.wheelLoads(m, this.roadHeight, dt, this.loads);
    for (let i = 0; i < 4; i++) this.tires[i].load = this.loads[i];

    // ---------- Controllo di trazione (aiuto) ----------
    let throttle = input.throttle;
    const rearSlip = Math.max(this.tires[RL].kappa, this.tires[RR].kappa) / car.tire.peakSlipRatio;
    // sulle monoposto (coppia enorme, poco peso) il controllo interviene più deciso
    const strongTc = !!car.ers;
    if (aids.tc && rearSlip > (strongTc ? 1.1 : 1.2) && this.speed > 2) this.tcCut = Math.min(1, this.tcCut + dt * (strongTc ? 25 : 12));
    else this.tcCut = Math.max(0, this.tcCut - dt * (strongTc ? 6 : 4));
    this.tcActive = this.tcCut > 0.05;
    throttle *= 1 - this.tcCut * (strongTc ? 1 : 0.85);
    // serbatoio vuoto: il motore si spegne
    if (this.fuel <= 0) throttle = 0;
    // limitatore box: taglia il gas sopra la velocità consentita
    if (this.speedLimiter > 0 && this.speed > this.speedLimiter - 0.3) throttle = Math.min(throttle, Math.max(0, (this.speedLimiter - this.speed) * 0.5));
    this.appliedThrottle = throttle;

    // ---------- Motore e trasmissione ----------
    const drive = this.drivetrain.update(
      dt, throttle, input.brake, this.tires[RL].omega, this.tires[RR].omega, this.speed, aids.autoShift,
    );

    // ---------- Sistema ibrido: recupero in frenata, spinta elettrica a gas aperto ----------
    const dtr = this.drivetrain;
    const coupled = dtr.gear > 0 && !dtr.isShifting && !dtr.clutchSlipping;
    const ersCrank = this.hybrid.updateEnergy(dt, throttle, input.brake, this.speed, dtr.rpm * RPM_TO_RADS, coupled);
    if (ersCrank !== 0) {
      const axle = ersCrank * dtr.ratio() * car.drivetrainEfficiency;
      drive.torqueRL += axle / 2;
      drive.torqueRR += axle / 2;
    }
    this.hybrid.updateAero(dt, throttle, input.brake, this.speed);

    // ---------- Consumo di carburante ----------
    // energia meccanica prodotta dal motore / (rendimento × potere calorifico 43 MJ/kg), più il minimo
    const power = Math.max(0, this.drivetrain.engineTorque) * this.drivetrain.rpm * RPM_TO_RADS;
    const burn = (power / (car.engineEfficiency * 43e6) + 0.0004) * this.env.fuelMultiplier * dt;
    this.fuel = Math.max(0, this.fuel - burn);
    this.fuelUsed += burn;

    // ---------- Forze delle gomme ----------
    let fLong = 0, fLat = 0, mz = 0;
    const r = car.wheelRadius;
    this.absActive = false;
    this.appliedBrake = input.brake;

    for (let i = 0; i < 4; i++) {
      const tire = this.tires[i];
      const [pLat, pLong] = this.wheelPos[i];
      const isFront = i < 2;
      const delta = isFront ? this.steerAngle : 0;
      const cd = Math.cos(delta), sd = Math.sin(delta);

      // Velocità del punto di contatto (riferimento auto), poi ruotata nel riferimento ruota
      const vcx = this.vLong - this.yawRate * pLat;
      const vcy = this.vLat + this.yawRate * pLong;
      const vxw = vcx * cd + vcy * sd;
      const vyw = -vcx * sd + vcy * cd;

      const surface = this.surfaces[i];
      const f = tire.computeForces(vxw, vyw, r, surface.grip, this.env, dt);
      // Resistenza al rotolamento (asfalto + extra della superficie, es. erba)
      const rr = (car.tire.rollingResistance + surface.drag) * tire.load * clamp(vxw, -1, 1);
      const fx = f.fx - rr;

      // ---- Rotazione della ruota ----
      let brakeTorque = car.maxBrakeTorque * input.brake * (isFront ? car.brakeBiasFront : 1 - car.brakeBiasFront) / 2;
      let driveTorque = i === RL ? drive.torqueRL : i === RR ? drive.torqueRR : 0;
      if (aids.abs && tire.kappa < -car.tire.peakSlipRatio * 1.15 && this.speed > 3) {
        // ABS: la ruota sta per bloccarsi → il freno non supera la coppia che la gomma trasmette
        // all'asfalto (così la ruota riprende a girare) e sulle posteriori si toglie il freno motore
        brakeTorque = Math.min(brakeTorque * 0.55, Math.abs(f.fx * r) * 0.85);
        if (driveTorque < 0) driveTorque = 0;
        this.absActive = true;
      }
      const inertia = car.wheelInertia + (isFront ? 0 : drive.reflectedInertia);
      let omega = tire.omega + ((driveTorque - f.fx * r) / inertia) * dt;
      // Il freno si oppone alla rotazione ma non può farla girare al contrario
      const brakeDelta = (brakeTorque / inertia) * dt;
      if (Math.abs(omega) <= brakeDelta) omega = 0;
      else omega -= Math.sign(omega) * brakeDelta;
      tire.omega = omega;
      tire.spin += omega * dt;

      // Forze riportate nel riferimento auto
      const bodyLong = fx * cd - f.fy * sd;
      const bodyLat = fx * sd + f.fy * cd;
      fLong += bodyLong;
      fLat += bodyLat;
      mz += pLong * bodyLat - pLat * bodyLong;
    }

    // ---------- Aerodinamica ----------
    // aree aerodinamiche attuali (ali aperte o chiuse) ed effetto suolo
    const areas = this.hybrid.aeroAreas();
    if (this.speed > 0.01) {
      const drag = 0.5 * AIR_DENSITY * areas.drag * this.speed * this.speed * this.dragFactor;
      fLong -= (drag * this.vLong) / this.speed;
      fLat -= (drag * this.vLat) / this.speed;
    }
    const sus = this.suspension;
    const ge = this.hybrid.groundEffectFactor(car.setup.rideHeight ?? car.groundEffect?.refRideHeight ?? 0, sus.heave, sus.pitch, car.wheelbase / 2);
    const vF = Math.max(0, this.vLong);
    const down = 0.5 * AIR_DENSITY * areas.lift * vF * vF * ge * this.downforceFactor;
    // ali aperte: il flap posteriore scarica soprattutto il retrotreno → bilanciamento un po' più avanti
    const bal = car.aeroBalanceFront + this.hybrid.aeroOpen * 0.04;
    const aero = { front: down * bal, rear: down * (1 - bal) };
    this.downforceN = down;

    // ---------- Integrazione (Eulero semi-implicito) ----------
    const axLocal = fLong / m;
    const ayLocal = fLat / m;
    this.vx += (fwdX * axLocal + leftX * ayLocal) * dt;
    this.vz += (fwdZ * axLocal + leftZ * ayLocal) * dt;
    this.yawRate += (mz / car.yawInertia) * dt;

    // Da fermi e senza gas: blocchiamo i residui numerici (attrito statico)
    if (this.speed < 0.05 && throttle < 0.01 && Math.abs(this.yawRate) < 0.02) {
      this.vx *= 0.5;
      this.vz *= 0.5;
      this.yawRate *= 0.5;
    }

    this.yaw += this.yawRate * dt;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // ---------- Carrozzeria sulle sospensioni ----------
    this.aLong = axLocal;
    this.aLat = ayLocal;
    this.suspension.integrate(m, axLocal, ayLocal, aero.front, aero.rear, dt);
    const k = damp(8, dt);
    this.aLongSmooth += (axLocal - this.aLongSmooth) * k;
    this.aLatSmooth += (ayLocal - this.aLatSmooth) * k;
  }
}
