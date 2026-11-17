/**
 * Grafici di telemetria in tempo reale (tasto G): ultimi 12 secondi.
 * Utili per capire cosa fa l'auto: dove freni, quanto sterzi, quanta
 * accelerazione laterale sfrutti, come salgono le temperature.
 */

interface Channel {
  label: string;
  color: string;
  min: number;
  max: number;
  /** Banda in cui disegnare il canale (0 = in alto, 1 = in basso) */
  band: [number, number];
  data: Float32Array;
}

const SECONDS = 12;
const RATE = 30; // campioni al secondo
const N = SECONDS * RATE;

export class TelemetryGraph {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private channels: Channel[];
  private head = 0;
  private acc = 0;
  visible = false;

  constructor(root: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-panel hud-graph';
    this.canvas.width = 460;
    this.canvas.height = 300;
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const ch = (label: string, color: string, min: number, max: number, band: [number, number]): Channel => ({
      label, color, min, max, band, data: new Float32Array(N),
    });
    this.channels = [
      ch('Velocità (0–300 km/h)', '#ffffff', 0, 300, [0, 0.25]),
      ch('Gas', '#3ddc84', 0, 1, [0.27, 0.45]),
      ch('Freno', '#ff4d4d', 0, 1, [0.27, 0.45]),
      ch('Sterzo', '#ffcc00', -1, 1, [0.47, 0.62]),
      ch('Acc. laterale (±2 g)', '#4aa3ff', -2, 2, [0.64, 0.8]),
      ch('Temp. gomme ant. (20–130 °C)', '#ff9f43', 20, 130, [0.82, 1]),
      ch('Temp. gomme post.', '#c56cf0', 20, 130, [0.82, 1]),
    ];
    this.setVisible(false);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.canvas.style.display = v ? 'block' : 'none';
  }

  /** Aggiunge un campione (i valori nello stesso ordine dei canali). */
  push(frameDt: number, values: number[]): void {
    this.acc += frameDt;
    if (this.acc < 1 / RATE) return;
    this.acc = 0;
    values.forEach((v, i) => (this.channels[i].data[this.head] = v));
    this.head = (this.head + 1) % N;
    if (this.visible) this.draw();
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height, pad = 6;
    ctx.clearRect(0, 0, W, H);
    ctx.font = '11px Segoe UI, sans-serif';

    // Separatori delle bande
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (const b of [0.26, 0.46, 0.63, 0.81]) {
      ctx.beginPath();
      ctx.moveTo(0, b * H);
      ctx.lineTo(W, b * H);
      ctx.stroke();
    }

    const labelY = new Map<number, number>();
    for (const c of this.channels) {
      const top = c.band[0] * H + pad, bottom = c.band[1] * H - pad;
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let k = 0; k < N; k++) {
        const v = c.data[(this.head + k) % N];
        const t = Math.min(1, Math.max(0, (v - c.min) / (c.max - c.min)));
        const x = (k / (N - 1)) * W;
        const y = bottom - t * (bottom - top);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // etichetta (le bande condivise impilano le etichette)
      const ly = (labelY.get(c.band[0]) ?? top + 9);
      labelY.set(c.band[0], ly + 12);
      ctx.fillStyle = c.color;
      ctx.fillText(c.label, 6, ly);
    }
  }
}
