/**
 * Il veicolo: corpo rigido che si muove sul piano (pista piatta) con 3 gradi
 * di libertà (x, z, imbardata) più 4 ruote indipendenti.
 *
 * SISTEMI DI RIFERIMENTO (uguali a Three.js e alla convenzione dei modelli Blender)
 *   Mondo: Y in alto, la pista sta sul piano XZ.
 *   Auto:  "avanti" = +Z locale, "sinistra" = +X locale.
 *   yaw:   rotazione attorno a Y; yaw positivo = l'auto gira a SINISTRA.
 *
 * A ogni passo:
 *   1. calcoliamo il carico su ogni ruota (statico + trasferimento + deportanza);
 *   2. il motore/cambio dà la coppia alle ruote posteriori;
 *   3. ogni gomma, dalla sua velocità e dal suo carico, produce forze;
 *   4. sommiamo forze e momenti → accelerazioni → nuove velocità e posizione.
 *
 * Sottosterzo e sovrasterzo NON sono programmati: emergono da come carico e
 * aderenza si distribuiscono tra anteriore e posteriore.
 */
import { clamp, damp, RAD } from '../core/math';
import type { DriverInput } from '../input/InputManager';
import { downforce, dragForce } from './Aero';
import type { CarParams } from './CarParams';
import { Drivetrain } from './Drivetrain';
import { Tire } from './Tire';

export const GRAVITY = 9.81;

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
export type SurfaceQuery = (wheelIndex: number, x: number, z: number) => Surface;

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
  /** Accelerazioni filtrate (m/s²) usate per il trasferimento di carico e la grafica. */
  aLong = 0;
  aLat = 0;
  /** Angolo di sterzo delle ruote anteriori (rad, + = sinistra). */
  steerAngle = 0;
  /** Angolo del volante in gradi (per la grafica dell'abitacolo). */
  steeringWheelDeg = 0;

  readonly tires: Tire[];
  readonly drivetrain: Drivetrain;
  /** Posizione delle ruote rispetto al baricentro: [laterale(+sx), longitudinale(+avanti)] */
  readonly wheelPos: [number, number][];
  /** Distanza baricentro → asse anteriore / posteriore */
  readonly cgToFront: number;
  readonly cgToRear: number;
  /** Superficie corrente sotto ogni ruota. */
  readonly surfaces: Surface[] = [];
  /** Ultimi input applicati (dopo gli aiuti), per HUD e audio. */
  appliedThrottle = 0;
  appliedBrake = 0;
  absActive = false;
  tcActive = false;

  private tcCut = 0;

  constructor(public car: CarParams, private surfaceQuery: SurfaceQuery) {
    this.tires = [0, 1, 2, 3].map(() => new Tire(car.tire));
    this.drivetrain = new Drivetrain(car);
    this.cgToFront = car.wheelbase * (1 - car.weightFront);
    this.cgToRear = car.wheelbase * car.weightFront;
    const tf = car.trackFront / 2, tr = car.trackRear / 2;
    this.wheelPos = [
      [tf, this.cgToFront],
      [-tf, this.cgToFront],
      [tr, -this.cgToRear],
      [-tr, -this.cgToRear],
    ];
    const def: Surface = { name: 'asfalto', grip: 1, drag: 0 };
    for (let i = 0; i < 4; i++) this.surfaces.push(def);
  }

  get totalMass(): number {
    return this.car.mass + this.car.fuelKg;
  }

  /** Riporta l'auto ferma in una posizione. */
  reset(x: number, z: number, yaw: number): void {
    this.x = this.prevX = x;
    this.z = this.prevZ = z;
    this.yaw = this.prevYaw = yaw;
    this.vx = this.vz = this.yawRate = 0;
    this.aLong = this.aLat = 0;
    this.tires.forEach((t) => t.reset());
    this.drivetrain.reset();
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

    // ---------- Carichi verticali ----------
    const L = car.wheelbase;
    const aero = downforce(car, Math.max(0, this.vLong));
    let front = (m * GRAVITY * this.cgToRear) / L + aero.front;
    let rear = (m * GRAVITY * this.cgToFront) / L + aero.rear;
    const longTransfer = (m * this.aLong * car.cgHeight) / L; // accelerando il peso va dietro
    front -= longTransfer;
    rear += longTransfer;
    const latTotal = m * this.aLat * car.cgHeight; // curvando a sinistra il peso va a destra
    const latFront = (latTotal * car.rollStiffnessFront) / car.trackFront;
    const latRear = (latTotal * (1 - car.rollStiffnessFront)) / car.trackRear;
    this.tires[FL].load = Math.max(0, front / 2 - latFront);
    this.tires[FR].load = Math.max(0, front / 2 + latFront);
    this.tires[RL].load = Math.max(0, rear / 2 - latRear);
    this.tires[RR].load = Math.max(0, rear / 2 + latRear);

    // ---------- Controllo di trazione (aiuto) ----------
    let throttle = input.throttle;
    const rearSlip = Math.max(this.tires[RL].kappa, this.tires[RR].kappa) / car.tire.peakSlipRatio;
    if (aids.tc && rearSlip > 1.2 && this.speed > 2) this.tcCut = Math.min(1, this.tcCut + dt * 12);
    else this.tcCut = Math.max(0, this.tcCut - dt * 4);
    this.tcActive = this.tcCut > 0.05;
    throttle *= 1 - this.tcCut * 0.85;
    this.appliedThrottle = throttle;

    // ---------- Motore e trasmissione ----------
    const drive = this.drivetrain.update(
      dt, throttle, input.brake, this.tires[RL].omega, this.tires[RR].omega, this.speed, aids.autoShift,
    );

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

      // Superficie sotto la ruota
      const wx = this.x + fwdX * pLong + leftX * pLat;
      const wz = this.z + fwdZ * pLong + leftZ * pLat;
      const surface = this.surfaceQuery(i, wx, wz);
      this.surfaces[i] = surface;

      const f = tire.computeForces(vxw, vyw, r, surface.grip, dt);
      // Resistenza al rotolamento (asfalto + extra della superficie, es. erba)
      const rr = (car.tire.rollingResistance + surface.drag) * tire.load * clamp(vxw, -1, 1);
      const fx = f.fx - rr;

      // ---- Rotazione della ruota ----
      let brakeTorque = car.maxBrakeTorque * input.brake * (isFront ? car.brakeBiasFront : 1 - car.brakeBiasFront) / 2;
      if (aids.abs && tire.kappa < -car.tire.peakSlipRatio * 1.15 && this.speed > 3) {
        brakeTorque *= 0.55; // ABS: rilascia la ruota che sta per bloccarsi
        this.absActive = true;
      }
      const driveTorque = i === RL ? drive.torqueRL : i === RR ? drive.torqueRR : 0;
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
    if (this.speed > 0.01) {
      const drag = dragForce(car, this.speed);
      fLong -= (drag * this.vLong) / this.speed;
      fLat -= (drag * this.vLat) / this.speed;
    }

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

    // Accelerazioni filtrate: il carico si trasferisce con il ritardo delle sospensioni
    const k = damp(1 / car.loadTransferLag, dt);
    this.aLong += (axLocal - this.aLong) * k;
    this.aLat += (ayLocal - this.aLat) * k;
  }
}
