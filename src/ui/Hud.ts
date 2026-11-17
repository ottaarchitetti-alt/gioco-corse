/**
 * HUD: elementi HTML sopra il canvas 3D.
 * (Fase 2/7: stato gomme e carburante; Fase 4: settori e delta.)
 */
import { formatLapTime } from '../core/math';

export interface HudData {
  speedKmh: number;
  gear: number;
  rpm: number;
  maxRpm: number;
  shifting: boolean;
  lap: number;
  current: number;
  lastLap: number | null;
  bestLap: number | null;
  valid: boolean;
  throttle: number;
  brake: number;
  steer: number;
  abs: boolean;
  absActive: boolean;
  tc: boolean;
  tcActive: boolean;
  autoShift: boolean;
  camera: string;
  device: string;
  trackName: string;
  carName: string;
  compound: string;
  /** Una voce per gomma: ant. sx, ant. dx, post. sx, post. dx */
  tyres: { temp: number; core: number; pressure: number; tread: number; grip: number; optimal: number }[];
}

/** Colore della temperatura gomma rispetto all'ideale: blu fredda, verde ok, rosso surriscaldata. */
function tempColor(t: number, opt: number): string {
  const d = t - opt;
  if (d < -35) return '#3b6fd8';
  if (d < -15) return '#36b5c9';
  if (d <= 12) return '#3ddc84';
  if (d <= 25) return '#ffcc00';
  return '#ff4d4d';
}

const h = (cls: string, html = ''): HTMLDivElement => {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  return d;
};

export class Hud {
  private laps: HTMLDivElement;
  private dash: HTMLDivElement;
  private inputs: HTMLDivElement;
  private info: HTMLDivElement;
  private msg: HTMLDivElement;
  readonly telemetry: HTMLDivElement;
  private tyres: HTMLDivElement;
  private msgTimer = 0;
  private lights: HTMLSpanElement[] = [];

  constructor(root: HTMLElement) {
    this.laps = h('hud-panel hud-laps');
    this.dash = h('hud-panel hud-dash', `
      <div class="shift-lights">${'<span></span>'.repeat(10)}</div>
      <div class="main">
        <div><div class="speed mono">0</div><div class="unit">km/h</div></div>
        <div class="gear mono">N</div>
      </div>
      <div class="rpm mono">0 giri/min</div>
      <div class="aids"><span data-a="abs">ABS</span><span data-a="tc">TC</span><span data-a="auto">AUTO</span></div>`);
    this.inputs = h('hud-panel hud-inputs', `
      <div class="bar brk"><i></i></div><div class="bar thr"><i></i></div><div class="steer"><i></i></div>`);
    this.info = h('hud-panel hud-info');
    this.msg = h('hud-panel hud-msg');
    this.telemetry = h('hud-panel hud-telemetry mono');
    this.tyres = h('hud-panel hud-tyres', `<div class="title"></div><div class="grid">${'<div class="tyre"><div class="t mono"></div><div class="p mono"></div><div class="w"><i></i></div></div>'.repeat(4)}</div>`);
    root.append(this.laps, this.dash, this.inputs, this.info, this.msg, this.telemetry, this.tyres);
    this.lights = Array.from(this.dash.querySelectorAll('.shift-lights span'));
  }

  /** Messaggio temporaneo al centro dello schermo. */
  message(text: string, seconds = 2.5): void {
    this.msg.textContent = text;
    this.msg.classList.add('show');
    this.msgTimer = seconds;
  }

  update(d: HudData, frameDt: number): void {
    if (this.msgTimer > 0) {
      this.msgTimer -= frameDt;
      if (this.msgTimer <= 0) this.msg.classList.remove('show');
    }

    const lapLabel = d.lap === 0 ? 'Giro di uscita' : `Giro ${d.lap}`;
    this.laps.innerHTML = `
      <div class="row"><span class="label">${lapLabel}</span>${d.valid ? '' : '<span class="invalid">NON VALIDO</span>'}</div>
      <div class="row current mono ${d.valid ? '' : 'invalid'}">${d.lap === 0 ? '-:--.---' : formatLapTime(d.current)}</div>
      <div class="row"><span class="label">Ultimo</span><span class="mono">${formatLapTime(d.lastLap)}</span></div>
      <div class="row"><span class="label">Migliore</span><span class="mono best">${formatLapTime(d.bestLap)}</span></div>`;

    (this.dash.querySelector('.speed') as HTMLElement).textContent = Math.round(d.speedKmh).toString();
    (this.dash.querySelector('.gear') as HTMLElement).textContent = d.gear < 0 ? 'R' : d.gear === 0 ? 'N' : String(d.gear);
    (this.dash.querySelector('.rpm') as HTMLElement).textContent = `${Math.round(d.rpm / 10) * 10} giri/min`;

    // Luci di cambiata: si accendono nell'ultimo 25% del regime
    const frac = (d.rpm / d.maxRpm - 0.75) / 0.22;
    const n = Math.round(Math.max(0, Math.min(1, frac)) * this.lights.length);
    const flash = d.rpm > d.maxRpm * 0.97 && Math.floor(performance.now() / 80) % 2 === 0;
    this.lights.forEach((l, i) => {
      l.className = i < n ? (i < 4 ? 'on-g' : i < 8 ? 'on-y' : 'on-r') : '';
    });
    this.dash.querySelector('.shift-lights')!.classList.toggle('flash', flash);

    const aids = this.dash.querySelectorAll<HTMLElement>('.aids span');
    aids[0].style.display = d.abs ? '' : 'none';
    aids[0].classList.toggle('on', d.absActive);
    aids[1].style.display = d.tc ? '' : 'none';
    aids[1].classList.toggle('on', d.tcActive);
    aids[2].style.display = d.autoShift ? '' : 'none';

    (this.inputs.querySelector('.thr i') as HTMLElement).style.height = `${d.throttle * 100}%`;
    (this.inputs.querySelector('.brk i') as HTMLElement).style.height = `${d.brake * 100}%`;
    (this.inputs.querySelector('.steer i') as HTMLElement).style.left = `${(0.5 - d.steer / 2) * 100 - 2}%`;

    // Gomme: colore = temperatura, numero = °C superficie, pressione, barra = battistrada
    (this.tyres.querySelector('.title') as HTMLElement).textContent = `Gomme · ${d.compound}`;
    const cells = this.tyres.querySelectorAll<HTMLElement>('.tyre');
    d.tyres.forEach((t, i) => {
      const c = cells[i];
      c.style.borderColor = tempColor(t.temp, t.optimal);
      c.style.background = tempColor(t.temp, t.optimal) + '33';
      (c.querySelector('.t') as HTMLElement).textContent = `${Math.round(t.temp)}°`;
      (c.querySelector('.p') as HTMLElement).textContent = `${t.pressure.toFixed(2)} bar`;
      const bar = c.querySelector('.w i') as HTMLElement;
      bar.style.width = `${t.tread * 100}%`;
      bar.style.background = t.tread > 0.5 ? '#3ddc84' : t.tread > 0.25 ? '#ffcc00' : '#ff4d4d';
      c.title = `Carcassa ${Math.round(t.core)} °C · battistrada ${(t.tread * 100).toFixed(0)}% · aderenza ${(t.grip * 100).toFixed(0)}%`;
    });

    this.info.innerHTML =`${d.trackName} · ${d.carName}<br>Telecamera: ${d.camera} (C) · Input: ${d.device}<br>H = aiuto · P = pausa`;
  }
}
