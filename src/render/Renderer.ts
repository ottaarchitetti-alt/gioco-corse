/**
 * Scena 3D: renderer, cielo, luci, ombre, nebbia.
 * Stile semi-realistico (D8): materiali PBR, tone mapping ACES, cielo fisico.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  /** Direzione da cui arriva il sole (versore). */
  private sunDir = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 4000);

    // ---- Cielo fisico ----
    const sky = new Sky();
    sky.scale.setScalar(10000);
    const u = sky.material.uniforms;
    u['turbidity'].value = 4;
    u['rayleigh'].value = 1.2;
    u['mieCoefficient'].value = 0.005;
    u['mieDirectionalG'].value = 0.8;
    const elevation = 38 * (Math.PI / 180), azimuth = 140 * (Math.PI / 180);
    this.sunDir.setFromSphericalCoords(1, Math.PI / 2 - elevation, azimuth);
    u['sunPosition'].value.copy(this.sunDir);
    this.scene.add(sky);

    // ---- Riflessi ambientali per i materiali PBR ----
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;

    // ---- Luci ----
    this.scene.add(new THREE.HemisphereLight('#cfe3ff', '#4a5a3a', 0.6));
    this.sun = new THREE.DirectionalLight('#fff3e0', 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -45;
    sc.right = sc.top = 45;
    sc.near = 1;
    sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    this.scene.fog = new THREE.Fog('#c9d8e6', 400, 2600);

    window.addEventListener('resize', this.onResize);
  }

  /** Le ombre coprono solo un'area attorno all'auto: la spostiamo con lei. */
  followShadows(target: THREE.Vector3): void {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDir, 200);
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Libera la memoria della GPU (usato dall'anteprima 3D dell'editor). */
  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => mat.dispose());
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
