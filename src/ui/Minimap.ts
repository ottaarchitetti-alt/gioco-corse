/**
 * Minimappa della pista nell'HUD: il tracciato visto dall'alto (nord in alto), la linea del
 * traguardo, la corsia box e le auto. Il pilota è il triangolo bianco che indica la direzione,
 * gli avversari sono puntini del colore della loro livrea.
 *
 * Il disegno della pista si fa una volta sola (canvas di sfondo); a ogni fotogramma si
 * ridisegnano solo le auto.
 */
import type { TrackSpline } from '../track/TrackSpline';

export interface MapCar {
  x: number;
  z: number;
  yaw: number;
  color: string;
  player: boolean;
  /** ai box o ritirato: disegnato più tenue */
  dim?: boolean;
}

const MAX = 190; // lato massimo (px CSS)
const PAD = 10;

export class Minimap {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement;
  private scale: number;
  private ox: number;
  private oz: number;
  private w: number;
  private h: number;
  private dpr: number;

  constructor(track: TrackSpline) {
    // ingombro della pista (e della corsia box)
    const pts = track.samples.map((s) => [s.x, s.z]);
    if (track.pit) for (const s of track.pit.samples) pts.push([s.x, s.z]);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of pts) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const spanX = Math.max(1, maxX - minX), spanZ = Math.max(1, maxZ - minZ);
    this.scale = (MAX - 2 * PAD) / Math.max(spanX, spanZ);
    this.w = Math.round(spanX * this.scale + 2 * PAD);
    this.h = Math.round(spanZ * this.scale + 2 * PAD);
    this.ox = minX;
    this.oz = minZ;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    this.el = document.createElement('div');
    this.el.className = 'hud-panel hud-minimap';
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    // ---- Sfondo: pista, box, traguardo ----
    this.bg = document.createElement('canvas');
    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;
    const g = this.bg.getContext('2d')!;
    g.scale(this.dpr, this.dpr);
    g.lineJoin = g.lineCap = 'round';
    const path = (samples: { x: number; z: number }[], closed: boolean) => {
      g.beginPath();
      samples.forEach((s, i) => {
        const [px, py] = this.toMap(s.x, s.z);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      if (closed) g.closePath();
    };
    const step = Math.max(1, Math.floor(track.samples.length / 600));
    const coarse = track.samples.filter((_, i) => i % step === 0);
    if (track.pit) {
      path(track.pit.samples, false);
      g.strokeStyle = 'rgba(150, 160, 175, 0.55)';
      g.lineWidth = 2;
      g.stroke();
    }
    path(coarse, true);
    g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    g.lineWidth = 6;
    g.stroke();
    g.strokeStyle = '#d9dde3';
    g.lineWidth = 3;
    g.stroke();
    // traguardo: trattino a scacchi perpendicolare alla pista
    const s0 = track.samples[0];
    const [sx, sy] = this.toMap(s0.x, s0.z);
    const nx = s0.nx, nz = s0.nz;
    g.strokeStyle = '#e8402f';
    g.lineWidth = 3;
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(sx - nx * 6, sy - nz * 6);
    g.lineTo(sx + nx * 6, sy + nz * 6);
    g.stroke();
  }

  /** Coordinate del mondo → pixel della mappa (nord in alto: x a destra, z in basso). */
  private toMap(x: number, z: number): [number, number] {
    return [PAD + (x - this.ox) * this.scale, PAD + (z - this.oz) * this.scale];
  }

  set visible(v: boolean) {
    this.el.style.display = v ? '' : 'none';
  }

  update(cars: MapCar[]): void {
    if (this.el.style.display === 'none') return;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.bg, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // prima gli avversari, poi il pilota sopra a tutti
    for (const c of cars) {
      if (c.player) continue;
      const [px, py] = this.toMap(c.x, c.z);
      g.globalAlpha = c.dim ? 0.45 : 1;
      g.beginPath();
      g.arc(px, py, 3.6, 0, Math.PI * 2);
      g.fillStyle = c.color;
      g.fill();
      g.lineWidth = 1.2;
      g.strokeStyle = '#111';
      g.stroke();
    }
    g.globalAlpha = 1;
    const me = cars.find((c) => c.player);
    if (me) {
      const [px, py] = this.toMap(me.x, me.z);
      // direzione di marcia (sin yaw, cos yaw) nel mondo = (x, z) sulla mappa
      const fx = Math.sin(me.yaw), fy = Math.cos(me.yaw);
      const lx = fy, ly = -fx; // perpendicolare
      g.beginPath();
      g.moveTo(px + fx * 7, py + fy * 7);
      g.lineTo(px - fx * 4.5 + lx * 4.5, py - fy * 4.5 + ly * 4.5);
      g.lineTo(px - fx * 4.5 - lx * 4.5, py - fy * 4.5 - ly * 4.5);
      g.closePath();
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = '#e8402f';
      g.stroke();
    }
  }
}
