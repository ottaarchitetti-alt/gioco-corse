/**
 * Fantasma: registra la traiettoria del giro e la riproduce come auto trasparente.
 * Si vede solo in prove libere e qualifica (in gara no).
 */
import * as THREE from 'three';

/** Campioni al secondo */
export const GHOST_RATE = 20;

export class GhostRecorder {
  private data: number[] = [];

  restart(): void {
    this.data = [];
  }

  /** @param lapTime tempo del giro in corso; registra solo quando serve un nuovo campione */
  sample(lapTime: number, x: number, z: number, yaw: number): void {
    if (lapTime >= this.data.length / 3 / GHOST_RATE) this.data.push(x, z, yaw);
  }

  get result(): number[] {
    return [...this.data];
  }
}

export class GhostPlayer {
  data: number[] | null = null;
  readonly object: THREE.Object3D;

  /** @param model modello dell'auto da cui fare la copia trasparente */
  constructor(model: THREE.Object3D) {
    this.object = model.clone(true);
    const mat = new THREE.MeshStandardMaterial({
      color: '#9fd3ff', transparent: true, opacity: 0.32, depthWrite: false, roughness: 0.4,
    });
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = mat;
        m.castShadow = false;
        m.receiveShadow = false;
      }
    });
    this.object.visible = false;
    this.object.name = 'ghost';
  }

  /**
   * Posiziona il fantasma al tempo t del giro (interpolando).
   * @param cgOffset distanza baricentro → origine del modello (come in CarView)
   */
  update(t: number | null, cgOffset: number): void {
    const d = this.data;
    if (!d || t === null || t < 0) {
      this.object.visible = false;
      return;
    }
    const n = d.length / 3;
    const k = t * GHOST_RATE;
    const i = Math.floor(k);
    if (i + 1 >= n) {
      this.object.visible = false;
      return;
    }
    const f = k - i;
    const x = d[i * 3] + (d[i * 3 + 3] - d[i * 3]) * f;
    const z = d[i * 3 + 1] + (d[i * 3 + 4] - d[i * 3 + 1]) * f;
    let dy = d[i * 3 + 5] - d[i * 3 + 2];
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const yaw = d[i * 3 + 2] + dy * f;
    this.object.position.set(x - Math.sin(yaw) * cgOffset, 0, z - Math.cos(yaw) * cgOffset);
    this.object.rotation.y = yaw;
    this.object.visible = true;
  }
}
