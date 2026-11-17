/**
 * Telecamere: esterna (inseguimento), cofano, abitacolo. Si cambiano con C.
 */
import * as THREE from 'three';
import { damp, lerpAngle } from '../core/math';
import type { CarView } from './CarView';

export type CameraMode = 'esterna' | 'cofano' | 'abitacolo';
export const CAMERA_MODES: CameraMode[] = ['esterna', 'cofano', 'abitacolo'];

const FOV: Record<CameraMode, number> = { esterna: 62, cofano: 68, abitacolo: 72 };

export class CameraRig {
  mode: CameraMode = 'esterna';
  private chaseYaw = 0;
  private chasePos = new THREE.Vector3();
  private initialized = false;
  private tmpQ = new THREE.Quaternion();
  private flipY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

  constructor(private camera: THREE.PerspectiveCamera, public view: CarView) {}

  next(): CameraMode {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.initialized = false;
    return this.mode;
  }

  update(frameDt: number, speed: number): void {
    const cam = this.camera;
    if (cam.fov !== FOV[this.mode]) {
      cam.fov = FOV[this.mode];
      cam.updateProjectionMatrix();
    }
    const rig = this.view.rig;

    if (this.mode === 'esterna') {
      // Insegue l'auto con un leggero ritardo nella rotazione (si vede la derapata)
      if (!this.initialized) {
        this.chaseYaw = this.view.yaw;
        this.initialized = true;
      }
      this.chaseYaw = lerpAngle(this.chaseYaw, this.view.yaw, damp(5, frameDt));
      const dist = 6.2 + Math.min(speed, 80) * 0.012;
      const target = new THREE.Vector3(
        this.view.position.x - Math.sin(this.chaseYaw) * dist,
        2.1,
        this.view.position.z - Math.cos(this.chaseYaw) * dist,
      );
      if (this.chasePos.lengthSq() === 0) this.chasePos.copy(target);
      this.chasePos.lerp(target, damp(18, frameDt));
      cam.position.copy(this.chasePos);
      cam.lookAt(
        this.view.position.x + Math.sin(this.view.yaw) * 2,
        0.9,
        this.view.position.z + Math.cos(this.view.yaw) * 2,
      );
      return;
    }

    // Cofano / abitacolo: agganciate ai punti del modello (si muovono con beccheggio e rollio)
    const anchor = this.mode === 'cofano' ? rig.camHood : rig.camCockpit;
    rig.root.updateMatrixWorld(true);
    if (anchor) {
      anchor.getWorldPosition(cam.position);
      anchor.getWorldQuaternion(this.tmpQ);
      // In glTF la camera guarda verso -Z; l'auto guarda verso +Z: ruotiamo di 180°
      cam.quaternion.copy(this.tmpQ).multiply(this.flipY);
    } else {
      const h = this.mode === 'cofano' ? 1.0 : 1.1;
      cam.position.set(this.view.position.x, h, this.view.position.z);
      cam.rotation.set(0, this.view.yaw + Math.PI, 0);
    }
  }
}
