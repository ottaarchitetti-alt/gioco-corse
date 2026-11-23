/**
 * Scena 3D: renderer, cielo, luci, ombre, nebbia.
 * Due stili (Impostazioni): pixel art (vedi PixelArt.ts) o semi-realistico (D8: materiali PBR,
 * tone mapping ACES, cielo fisico).
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { loadSettings, qualityParams, type GameSettings, type Quality } from '../ui/Settings';
import { PALETTE_SHADER, PIXEL_HORIZON, PIXEL_SIZES, PixelArtPass, pixelSkyTexture, stylizeScene } from './PixelArt';

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Direzione da cui arriva il sole (versore). */
  private sunDir = new THREE.Vector3();
  /** Stile pixel art: catena di effetti (null = stile realistico) */
  private composer: EffectComposer | null = null;
  private pixelPass: PixelArtPass | null = null;
  private palettePass: ShaderPass | null = null;
  private pixelSize = 3;
  readonly sky: THREE.Object3D;
  private pixelSky: THREE.Texture | null = null;
  /** ogni tanto si convertono i materiali nuovi (auto aggiunte, fantasma...) */
  private stylizeTimer = 0;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const qp = qualityParams(loadSettings().quality);
    this.renderer.setPixelRatio(qp.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = qp.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 4000);

    // ---- Cielo fisico ----
    const sky = new Sky();
    this.sky = sky;
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
    this.hemi = new THREE.HemisphereLight('#cfe3ff', '#4a5a3a', 0.6);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff3e0', 2.6);
    this.sun.castShadow = qp.shadows;
    this.sun.shadow.mapSize.set(qp.shadowMap, qp.shadowMap);
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
    this.applyStyle(loadSettings());
  }

  get pixelArt(): boolean {
    return this.composer !== null;
  }

  /** Stile grafico: pixel art (bassa risoluzione, contorni, palette, luce a bande) o realistico. */
  applyStyle(s: Pick<GameSettings, 'style' | 'pixelSize' | 'quality'>): void {
    const want = s.style === 'pixel';
    this.pixelSize = PIXEL_SIZES[s.pixelSize] ?? 3;
    if (want && !this.composer) {
      // la risoluzione la decidono i pixel grandi: niente schermo "retina", niente sfumature
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      const c = new EffectComposer(this.renderer);
      c.setPixelRatio(1);
      this.pixelPass = new PixelArtPass(this.scene, this.camera, this.pixelSize);
      c.addPass(this.pixelPass);
      c.addPass(new OutputPass());
      this.palettePass = new ShaderPass(PALETTE_SHADER);
      c.addPass(this.palettePass);
      c.setSize(window.innerWidth, window.innerHeight);
      this.composer = c;
      this.scene.environmentIntensity = 0;
    } else if (!want && this.composer) {
      this.composer.dispose();
      this.pixelPass?.dispose();
      this.composer = null;
      this.pixelPass = null;
      this.palettePass = null;
      this.scene.environmentIntensity = 0.35;
      this.renderer.setPixelRatio(qualityParams(s.quality).pixelRatio);
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
    if (this.pixelPass && this.pixelPass.pixelSize !== this.pixelSize) this.pixelPass.setPixelSize(this.pixelSize);
    if (this.palettePass) this.palettePass.uniforms.pixelSize.value = this.pixelSize;
    stylizeScene(this.scene, want);
    // cielo: in pixel art un cielo disegnato a fasce con nuvole a pixel, nebbia dello stesso colore
    this.sky.visible = !want;
    if (want) this.pixelSky ??= pixelSkyTexture();
    this.scene.background = want ? this.pixelSky : null;
    (this.scene.fog as THREE.Fog).color.set(want ? PIXEL_HORIZON : '#c9d8e6');
    document.body.classList.toggle('pixel-style', want);
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
    if (this.composer) {
      // materiali degli oggetti aggiunti dopo (auto di una nuova sessione, fantasma...)
      if (--this.stylizeTimer <= 0) {
        this.stylizeTimer = 30;
        stylizeScene(this.scene, true);
      }
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Applica una qualità grafica senza ricaricare (ombre e risoluzione). */
  applyQuality(q: Quality): void {
    const qp = qualityParams(q);
    this.renderer.setPixelRatio(this.composer ? 1 : qp.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    const changed = this.renderer.shadowMap.enabled !== qp.shadows || this.sun.shadow.mapSize.x !== qp.shadowMap;
    this.renderer.shadowMap.enabled = qp.shadows;
    this.sun.castShadow = qp.shadows;
    if (this.sun.shadow.mapSize.x !== qp.shadowMap) {
      this.sun.shadow.mapSize.set(qp.shadowMap, qp.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    // i materiali vanno ricompilati quando le ombre si accendono/spengono
    if (changed) this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true));
    });
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
    this.composer?.dispose();
    this.pixelPass?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer?.setSize(window.innerWidth, window.innerHeight);
  }
}
