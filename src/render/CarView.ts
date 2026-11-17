/**
 * Collega lo stato fisico del veicolo al modello 3D (solo grafica).
 * Interpola tra gli ultimi due passi fisici per un movimento fluido.
 */
import * as THREE from 'three';
import { lerp, lerpAngle, RAD } from '../core/math';
import type { Vehicle } from '../physics/Vehicle';
import type { CarRig } from './AssetManager';

/** Quanto la carrozzeria si inclina per ogni m/s² di accelerazione (radianti). */
const PITCH_PER_ACC = 0.0035;
const ROLL_PER_ACC = 0.005;

export class CarView {
  /** Posizione interpolata (origine del modello) e imbardata, per le telecamere. */
  readonly position = new THREE.Vector3();
  yaw = 0;

  constructor(readonly rig: CarRig, private vehicle: Vehicle) {}

  update(alpha: number): void {
    const v = this.vehicle;
    const x = lerp(v.prevX, v.x, alpha);
    const z = lerp(v.prevZ, v.z, alpha);
    this.yaw = lerpAngle(v.prevYaw, v.yaw, alpha);

    // La fisica lavora sul baricentro; il modello ha l'origine a metà passo.
    const cgOffset = v.car.wheelbase / 2 - v.cgToFront;
    this.position.set(x - Math.sin(this.yaw) * cgOffset, 0, z - Math.cos(this.yaw) * cgOffset);

    const rig = this.rig;
    rig.root.position.copy(this.position);
    rig.root.rotation.y = this.yaw;

    // Beccheggio e rollio dalla fisica (accelerazioni filtrate)
    rig.body.rotation.x = -v.aLong * PITCH_PER_ACC;
    rig.body.rotation.z = v.aLat * ROLL_PER_ACC;

    for (let i = 0; i < 4; i++) {
      if (i < 2) rig.wheelPivots[i].rotation.y = v.steerAngle;
      rig.wheelSpinners[i].rotation.x = v.tires[i].spin;
    }
    if (rig.steeringWheel) rig.steeringWheel.rotation.z = -v.steeringWheelDeg * RAD;
  }
}
