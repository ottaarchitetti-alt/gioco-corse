/**
 * PIOGGIA a schermo:
 *   - gocce: segmenti che cadono in un "cubo" attorno alla telecamera (più ne piove, più se ne vedono);
 *   - cielo e luce: nuvole (meno sole, cielo grigio), nebbia più vicina;
 *   - asfalto bagnato: più scuro e lucido (riflette il cielo);
 *   - spruzzi: una nuvola d'acqua dietro ogni auto veloce sulla pista bagnata (visibilità ridotta).
 */
import * as THREE from 'three';

const DROPS = 3000;
const BOX = { x: 60, y: 30, z: 60 };

/** Sprite morbido (gradiente radiale) per gli spruzzi */
function sprayTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, 'rgba(225,230,238,0.85)');
  grd.addColorStop(0.5, 'rgba(210,216,226,0.35)');
  grd.addColorStop(1, 'rgba(200,206,216,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class RainFx {
  private drops: THREE.LineSegments;
  private pos: Float32Array;
  private wetMats: { m: THREE.MeshStandardMaterial; rough: number; color: THREE.Color }[] = [];
  private spray = new Map<object, THREE.Sprite>();
  private sprayMat: THREE.SpriteMaterial;
  private base: { fogNear: number; fogFar: number; fogColor: THREE.Color; sun: number; hemi: number; exposure: number; sky: Record<string, number> } | null = null;

  constructor(private scene: THREE.Scene, private sun: THREE.DirectionalLight, private hemi: THREE.HemisphereLight | null, private gl: THREE.WebGLRenderer,
    private sky: THREE.Object3D | null = null) {
    this.pos = new Float32Array(DROPS * 6);
    for (let i = 0; i < DROPS; i++) this.respawn(i, true, new THREE.Vector3());
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ color: '#b8c4d4', transparent: true, opacity: 0.45, fog: false });
    this.drops = new THREE.LineSegments(geo, mat);
    this.drops.frustumCulled = false;
    scene.add(this.drops);
    this.sprayMat = new THREE.SpriteMaterial({ map: sprayTexture(), transparent: true, depthWrite: false, opacity: 0 });
  }

  /** I materiali della pista che si bagnano (asfalto, cordoli) */
  registerWet(root: THREE.Object3D): void {
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && !Array.isArray(m) && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !this.wetMats.some((x) => x.m === m)) {
        this.wetMats.push({ m, rough: m.roughness, color: m.color.clone() });
      }
    });
  }

  private respawn(i: number, anywhere: boolean, cam: THREE.Vector3): void {
    const x = cam.x + (Math.random() - 0.5) * BOX.x;
    const z = cam.z + (Math.random() - 0.5) * BOX.z;
    const y = cam.y + (anywhere ? (Math.random() - 0.5) * BOX.y : BOX.y / 2);
    const k = i * 6;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.pos[k + 3] = x + 0.08; this.pos[k + 4] = y + 0.9; this.pos[k + 5] = z + 0.04;
  }

  /**
   * @param rain pioggia 0..1, wet pista bagnata 0..1
   * @param cars posizione e velocità delle auto (per gli spruzzi)
   */
  update(dt: number, camera: THREE.Camera, rain: number, wet: number, cars: { key: object; x: number; z: number; yaw: number; speed: number; visible: boolean }[]): void {
    const fog = this.scene.fog as THREE.Fog | null;
    this.base ??= {
      fogNear: fog?.near ?? 400, fogFar: fog?.far ?? 2600, fogColor: fog ? fog.color.clone() : new THREE.Color('#c9d8e6'),
      sun: this.sun.intensity, hemi: this.hemi?.intensity ?? 0.6, exposure: this.gl.toneMappingExposure,
      sky: Object.fromEntries(['turbidity', 'rayleigh', 'mieCoefficient'].map((k) => [k, this.skyU()?.[k]?.value ?? 0])),
    };
    const b = this.base;
    // nuvole: con la pioggia (o pista ancora bagnata) il cielo resta coperto
    const cloud = Math.min(1, rain * 1.4 + wet * 0.3);
    if (fog) {
      fog.near = b.fogNear * (1 - 0.85 * rain);
      fog.far = b.fogFar * (1 - 0.7 * rain);
      fog.color.copy(b.fogColor).lerp(new THREE.Color('#8f99a6'), cloud);
    }
    this.sun.intensity = b.sun * (1 - 0.7 * cloud);
    // cielo fisico: coperto (più "torbido", meno azzurro)
    const u = this.skyU();
    if (u) {
      u.turbidity.value = b.sky.turbidity + (20 - b.sky.turbidity) * cloud;
      u.rayleigh.value = b.sky.rayleigh * (1 - 0.85 * cloud);
      u.mieCoefficient.value = b.sky.mieCoefficient + (0.06 - b.sky.mieCoefficient) * cloud;
    }
    if (this.hemi) this.hemi.intensity = b.hemi * (1 - 0.25 * cloud);
    this.gl.toneMappingExposure = b.exposure * (1 - 0.15 * cloud);
    // asfalto bagnato: più scuro e più liscio (lucido)
    for (const w of this.wetMats) {
      w.m.roughness = w.rough * (1 - 0.65 * wet);
      w.m.color.copy(w.color).multiplyScalar(1 - 0.35 * wet);
    }

    // ---- gocce ----
    const n = Math.round(DROPS * Math.min(1, rain * 1.2));
    this.drops.geometry.setDrawRange(0, n * 2);
    this.drops.visible = n > 0;
    if (n > 0) {
      const cam = camera.position;
      const fall = (14 + 8 * rain) * dt;
      for (let i = 0; i < n; i++) {
        const k = i * 6;
        this.pos[k + 1] -= fall;
        this.pos[k + 4] -= fall;
        const dx = this.pos[k] - cam.x, dz = this.pos[k + 2] - cam.z;
        if (this.pos[k + 1] < cam.y - BOX.y / 2 || Math.abs(dx) > BOX.x / 2 || Math.abs(dz) > BOX.z / 2) this.respawn(i, this.pos[k + 1] >= cam.y - BOX.y / 2, cam);
      }
      (this.drops.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.drops.material as THREE.LineBasicMaterial).opacity = 0.25 + 0.35 * rain;
    }

    // ---- spruzzi dietro le auto ----
    for (const c of cars) {
      let s = this.spray.get(c.key);
      const strength = c.visible ? Math.max(0, wet - 0.15) * Math.min(1, Math.max(0, c.speed - 12) / 45) : 0;
      if (!s && strength <= 0) continue;
      if (!s) {
        s = new THREE.Sprite(this.sprayMat.clone());
        this.scene.add(s);
        this.spray.set(c.key, s);
      }
      s.visible = strength > 0.01;
      if (!s.visible) continue;
      const back = 3.2 + c.speed * 0.04;
      s.position.set(c.x - Math.sin(c.yaw) * back, 0.7 + strength * 0.6, c.z - Math.cos(c.yaw) * back);
      const size = 3 + strength * 6;
      s.scale.set(size * 1.4, size * 0.7, 1);
      (s.material as THREE.SpriteMaterial).opacity = Math.min(0.85, strength * 1.2);
    }
  }

  private skyU(): Record<string, { value: number }> | null {
    const m = (this.sky as THREE.Mesh | null)?.material as THREE.ShaderMaterial | undefined;
    return m?.uniforms && 'turbidity' in m.uniforms ? (m.uniforms as unknown as Record<string, { value: number }>) : null;
  }

  /** Nuova sessione: niente spruzzi di auto che non ci sono più */
  clearSpray(): void {
    for (const s of this.spray.values()) {
      this.scene.remove(s);
      (s.material as THREE.Material).dispose();
    }
    this.spray.clear();
  }
}
