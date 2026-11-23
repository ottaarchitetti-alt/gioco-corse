/**
 * STILE PIXEL ART per la scena 3D.
 *
 * La scena resta 3D, ma viene disegnata come un'illustrazione in pixel art:
 *  1. PixelArtPass — la scena si disegna a bassa risoluzione (1/pixelSize) e si ingrandisce
 *     senza sfumare (ogni pixel diventa un quadrato netto). Sulle sagome si disegna un
 *     contorno scuro (bordo di profondità) e sugli spigoli una linea più chiara (bordo delle
 *     normali), come nei disegni a mano.
 *  2. Materiali "a bande" (toon): la luce non sfuma ma cambia a 4 gradini.
 *  3. PALETTE_SHADER — dopo il tone mapping: colori ridotti a pochi livelli con una
 *     retinatura ordinata 4×4 (dithering di Bayer) allineata ai pixel grandi, e un po' più
 *     di saturazione.
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export type PixelSize = 'fine' | 'medio' | 'grosso';
export const PIXEL_SIZES: Record<PixelSize, number> = { fine: 2, medio: 3, grosso: 4 };

// =====================================================================
//  1) Scena a bassa risoluzione con contorni
// =====================================================================

export class PixelArtPass extends Pass {
  private beauty = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  private normals = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  private normalMaterial = new THREE.MeshNormalMaterial();
  private quad: FullScreenQuad;
  private material: THREE.ShaderMaterial;
  private size = new THREE.Vector2(1, 1);

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, public pixelSize: number) {
    super();
    for (const rt of [this.beauty, this.normals]) {
      rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
      rt.texture.generateMipmaps = false;
    }
    this.beauty.depthTexture = new THREE.DepthTexture(1, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        tNormal: { value: null },
        texel: { value: new THREE.Vector2() },
        near: { value: 0.1 },
        far: { value: 1000 },
        outline: { value: new THREE.Color('#0c0e14') },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform sampler2D tNormal;
        uniform vec2 texel;
        uniform float near;
        uniform float far;
        uniform vec3 outline;
        varying vec2 vUv;

        // profondità lineare in metri (il depth buffer non è lineare)
        float lin(vec2 uv) {
          float d = texture2D(tDepth, uv).r;
          return near * far / (far - d * (far - near));
        }
        vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).rgb * 2.0 - 1.0; }

        void main() {
          vec4 c = texture2D(tColor, vUv);
          float z = lin(vUv);
          vec3 n = nrm(vUv);
          // CONTORNO. Su una superficie piana l'inverso della profondità (w = 1/z) cambia in modo
          // lineare sullo schermo: anche il prato visto di taglio ha "derivata seconda" nulla.
          // Una sagoma invece è un salto: w cambia di colpo da un lato solo. Il contorno va sul
          // pixel più vicino (quello davanti), così la linea "abbraccia" l'oggetto.
          float w = 1.0 / z;
          float wl = 1.0 / lin(vUv - vec2(texel.x, 0.0)), wr = 1.0 / lin(vUv + vec2(texel.x, 0.0));
          float wd = 1.0 / lin(vUv - vec2(0.0, texel.y)), wu = 1.0 / lin(vUv + vec2(0.0, texel.y));
          float lap = max(abs(wl + wr - 2.0 * w), abs(wu + wd - 2.0 * w)) / w;
          float behind = (w - min(min(wl, wr), min(wu, wd))) / w; // quanto è più lontano il vicino
          float edge = (z < far * 0.6 && lap > 0.08 && behind > 0.08) ? 1.0 : 0.0;
          // SPIGOLO: normali molto diverse alla stessa profondità (pannelli, alettoni, ruote)
          float crease = 0.0;
          vec2 offs[4];
          offs[0] = vec2(1.0, 0.0); offs[1] = vec2(-1.0, 0.0); offs[2] = vec2(0.0, 1.0); offs[3] = vec2(0.0, -1.0);
          for (int i = 0; i < 4; i++) {
            vec2 uv2 = vUv + offs[i] * texel;
            float z2 = lin(uv2);
            vec3 n2 = nrm(uv2);
            if (abs(z2 - z) < z * 0.03 && dot(n, n2) < 0.55 && dot(n - n2, vec3(1.0)) > 0.0) crease = 1.0;
          }
          // i dettagli si vedono da vicino: oltre ~150 m niente linee interne, oltre ~900 m niente contorni
          crease *= 1.0 - smoothstep(60.0, 150.0, z);
          edge *= 1.0 - smoothstep(500.0, 900.0, z);
          vec3 col = c.rgb;
          col = mix(col, col * 1.35 + 0.03, crease * 0.6);
          col = mix(col, outline, edge * 0.92);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number): void {
    this.size.set(width, height);
    const w = Math.max(1, Math.floor(width / this.pixelSize));
    const h = Math.max(1, Math.floor(height / this.pixelSize));
    this.beauty.setSize(w, h);
    this.normals.setSize(w, h);
    this.material.uniforms.texel.value.set(1 / w, 1 / h);
  }

  setPixelSize(px: number): void {
    this.pixelSize = px;
    this.setSize(this.size.x, this.size.y);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget): void {
    const u = this.material.uniforms;
    u.near.value = this.camera.near;
    u.far.value = this.camera.far;
    renderer.setRenderTarget(this.beauty);
    renderer.render(this.scene, this.camera);
    // normali (per gli spigoli): stessa scena con un materiale che le disegna come colori
    const old = this.scene.overrideMaterial;
    const bg = this.scene.background;
    this.scene.overrideMaterial = this.normalMaterial;
    renderer.setRenderTarget(this.normals);
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = old;
    this.scene.background = bg;
    u.tColor.value = this.beauty.texture;
    u.tDepth.value = this.beauty.depthTexture;
    u.tNormal.value = this.normals.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.beauty.dispose();
    this.normals.dispose();
    this.normalMaterial.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}

// =====================================================================
//  3) Palette ridotta e retinatura (dopo il tone mapping, in sRGB)
// =====================================================================

export const PALETTE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    pixelSize: { value: 3 },
    levels: { value: 9 },
    dither: { value: 0.9 },
    saturation: { value: 1.18 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float pixelSize;
    uniform float levels;
    uniform float dither;
    uniform float saturation;
    varying vec2 vUv;

    // matrice di Bayer 4×4 (valori 0..15)
    float bayer(vec2 p) {
      int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
      int i = x + y * 4;
      int m[16];
      m[0]=0; m[1]=8; m[2]=2; m[3]=10; m[4]=12; m[5]=4; m[6]=14; m[7]=6;
      m[8]=3; m[9]=11; m[10]=1; m[11]=9; m[12]=15; m[13]=7; m[14]=13; m[15]=5;
      for (int k = 0; k < 16; k++) if (k == i) return float(m[k]);
      return 0.0;
    }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = clamp(mix(vec3(l), c, saturation), 0.0, 1.0);
      // retinatura allineata ai pixel grandi
      vec2 p = floor(gl_FragCoord.xy / pixelSize);
      float b = (bayer(p) + 0.5) / 16.0 - 0.5;
      c = floor(c * (levels - 1.0) + 0.5 + b * dither) / (levels - 1.0);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

// =====================================================================
//  Cielo disegnato (pixel art)
// =====================================================================

/** colore dell'orizzonte (anche la nebbia lontana usa questo colore) */
export const PIXEL_HORIZON = '#cfe6f5';

/**
 * Cielo in proiezione equirettangolare (gira con la telecamera): fasce di azzurro sempre più
 * scuro verso l'alto e nuvole fatte a blocchi, con la base in ombra.
 */
export function pixelSkyTexture(): THREE.CanvasTexture {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  const rowOf = (elevDeg: number) => Math.round(((90 - elevDeg) / 180) * H);
  // fasce: [elevazione minima, colore]
  const bands: [number, string][] = [
    [-90, PIXEL_HORIZON], [2, '#bfe0f6'], [5, '#a6d4f3'], [9, '#8cc6ef'], [15, '#72b5ea'],
    [24, '#5ca3e3'], [36, '#4b90da'], [55, '#3f7fcf'],
  ];
  bands.forEach(([e, col], i) => {
    const top = i + 1 < bands.length ? rowOf(bands[i + 1][0]) : 0;
    g.fillStyle = col;
    g.fillRect(0, top, W, rowOf(e) - top);
  });
  // nuvole: gruppi di rettangoli (blocchi da 4 pixel), base grigio-azzurra
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const B = 4;
  for (let k = 0; k < 26; k++) {
    const cx = Math.floor(rnd() * W), elev = 4 + rnd() * 20;
    const cy = rowOf(elev);
    const w = 12 + Math.floor(rnd() * 22), h = 3 + Math.floor(rnd() * 3); // in blocchi
    for (let j = 0; j < h; j++) {
      // ogni riga è più stretta verso l'alto: forma "a cumulo"
      const shrink = Math.floor((h - j - 1) * (2 + rnd() * 2));
      const x0 = cx + (shrink + Math.floor(rnd() * 2)) * B, x1 = cx + (w - shrink - Math.floor(rnd() * 2)) * B;
      g.fillStyle = j === h - 1 ? '#d3e2ef' : j === h - 2 ? '#eef5fb' : '#ffffff';
      for (const off of [0, -W]) g.fillRect(x0 + off, cy - (h - j) * B, x1 - x0, B); // anche a cavallo del bordo
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

// =====================================================================
//  2) Materiali a bande (toon)
// =====================================================================

let gradient: THREE.DataTexture | null = null;
/** Sfumatura della luce a 4 gradini (ombra, mezzatinta, luce, riflesso). */
function toonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const steps = [70, 130, 195, 255];
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  gradient = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

const toonCache = new WeakMap<THREE.Material, THREE.MeshToonMaterial>();
/** materiale a bande → originale (mappa a parte: userData verrebbe copiato come testo nei clone) */
const originals = new WeakMap<THREE.Material, THREE.Material>();

/** Versione "a bande" di un materiale PBR. Colore e texture sono condivisi con l'originale,
 *  così chi cambia il colore (livree, fascia della mescola) lo cambia anche qui. */
function toonOf(m: THREE.MeshStandardMaterial): THREE.MeshToonMaterial {
  let t = toonCache.get(m);
  if (!t) {
    t = new THREE.MeshToonMaterial({ gradientMap: toonGradient() });
    t.name = m.name;
    t.color = m.color;
    t.map = m.map;
    t.emissive = m.emissive;
    t.emissiveIntensity = m.emissiveIntensity;
    t.transparent = m.transparent;
    t.opacity = m.opacity;
    t.depthWrite = m.depthWrite;
    t.side = m.side;
    t.alphaTest = m.alphaTest;
    t.vertexColors = m.vertexColors;
    originals.set(t, m);
    toonCache.set(m, t);
  }
  // l'opacità può cambiare (es. fantasma): la si tiene allineata
  t.opacity = m.opacity;
  return t;
}

/** Passa a materiali a bande (on = true) o torna ai materiali originali (on = false). */
export function stylizeScene(root: THREE.Object3D, on: boolean): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const conv = (m: THREE.Material): THREE.Material => {
      if (on) return (m as THREE.MeshStandardMaterial).isMeshStandardMaterial ? toonOf(m as THREE.MeshStandardMaterial) : m;
      const orig = originals.get(m);
      if (orig) return orig;
      // materiale a bande nato da una copia (es. livrea di un'auto creata in pixel art): se ne fa
      // uno "normale" con lo stesso colore e la stessa texture
      if ((m as THREE.MeshToonMaterial).isMeshToonMaterial) {
        const t = m as THREE.MeshToonMaterial;
        const std = new THREE.MeshStandardMaterial({ color: t.color, map: t.map, transparent: t.transparent, opacity: t.opacity, side: t.side, roughness: 0.6 });
        std.name = t.name;
        originals.set(t, std);
        toonCache.set(std, t);
        return std;
      }
      return m;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(conv) : conv(mesh.material);
  });
}
