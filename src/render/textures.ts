/**
 * Texture generate via codice (Canvas 2D), così il progetto non dipende da
 * file immagine esterni. In futuro puoi sostituirle con texture fotografiche
 * mettendo i file in /public/textures e caricandoli con THREE.TextureLoader.
 */
import * as THREE from 'three';

/** Generatore pseudo-casuale deterministico (stesso risultato a ogni avvio). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

function noise(ctx: CanvasRenderingContext2D, size: number, base: [number, number, number], amp: number, seed: number) {
  const img = ctx.createImageData(size, size);
  const rnd = seededRandom(seed);
  for (let i = 0; i < size * size; i++) {
    const n = (rnd() - 0.5) * amp;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function toTexture(c: HTMLCanvasElement, anisotropy: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

/** Asfalto: grana fine + linee bianche ai bordi. U = trasversale (0..1), V = lungo la pista. */
export function asphaltTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const [c, ctx] = makeCanvas(size);
  noise(ctx, size, [62, 62, 66], 34, 7);
  // macchie leggere per spezzare la ripetizione
  const rnd = seededRandom(11);
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(${rnd() < 0.5 ? '30,30,30' : '95,95,100'},0.06)`;
    ctx.beginPath();
    ctx.arc(rnd() * size, rnd() * size, 10 + rnd() * 40, 0, Math.PI * 2);
    ctx.fill();
  }
  // linee bianche di bordo pista
  ctx.fillStyle = 'rgba(235,235,235,0.95)';
  ctx.fillRect(size * 0.012, 0, size * 0.018, size);
  ctx.fillRect(size * 0.97, 0, size * 0.018, size);
  return toTexture(c, anisotropy);
}

export function grassTexture(anisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const [c, ctx] = makeCanvas(size);
  noise(ctx, size, [62, 98, 44], 30, 3);
  const rnd = seededRandom(5);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${rnd() < 0.5 ? '40,70,30' : '90,120,60'},0.10)`;
    ctx.beginPath();
    ctx.arc(rnd() * size, rnd() * size, 6 + rnd() * 26, 0, Math.PI * 2);
    ctx.fill();
  }
  return toTexture(c, anisotropy);
}

/** Scacchi per la linea di partenza. */
export function checkerTexture(): THREE.CanvasTexture {
  const size = 128;
  const [c, ctx] = makeCanvas(size);
  const n = 8;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#111' : '#eee';
      ctx.fillRect((x * size) / n, (y * size) / n, size / n, size / n);
    }
  const t = toTexture(c, 4);
  t.magFilter = THREE.NearestFilter;
  return t;
}
