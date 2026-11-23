/**
 * HUD: elementi HTML sopra il canvas 3D.
 *   - in alto a sinistra: sessione, giro, settori colorati, delta, classifica
 *   - in alto al centro: semaforo di partenza e messaggi
 *   - in basso: cruscotto, pedali, gomme
 */
import { formatLapTime } from '../core/math';

/** viola = record assoluto, verde = tuo migliore della sessione, giallo = più lento */
export type SectorColor = 'viola' | 'verde' | 'giallo' | '';

export interface TimingHud {
  sessionName: string;
  /** es. "Giro 3/10", "08:32", "Bandiera a scacchi" */
  sessionInfo: string;
  position: number;
  total: number;
  lap: number;
  current: number;
  /** Delta rispetto al riferimento (s): negativo = più veloce */
  delta: number | null;
  deltaRef: string;
  valid: boolean;
  lastLap: number | null;
  bestLap: number | null;
  recordLap: number | null;
  sectors: { time: number | null; color: SectorColor }[];
}

export interface StandingRow {
  pos: number;
  name: string;
  gap: string;
  player: boolean;
}

export interface HudData {
  speedKmh: number;
  gear: number;
  rpm: number;
  maxRpm: number;
  shifting: boolean;
  timing: TimingHud;
  standings: StandingRow[];
  /** Luci del semaforo accese (0..5), −1 = semaforo nascosto */
  lights: number;
  /** Bandiera da mostrare */
  flag: 'gialla' | 'blu' | null;
  /** Sei nella scia di un'altra auto */
  draft: boolean;
  /** Carburante a bordo (kg) e giri stimati */
  fuel: number;
  fuelLaps: number;
  /** Limitatore della corsia box attivo */
  limiter: boolean;
  /** Pit stop in corso */
  pit: { phase: string; left: number; total: number } | null;
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
  /** Monoposto: batteria, potenza elettrica, modalità, Overtake mode, ali aperte (null = auto senza ERS) */
  ers: { charge: number; powerKW: number; mode: string; overtake: 'no' | 'disponibile' | 'attivo'; aeroOpen: number; aeroZone: boolean } | null;
  /** Una voce per gomma: ant. sx, ant. dx, post. sx, post. dx */
  tyres: { temp: number; core: number; pressure: number; tread: number; grip: number; optimal: number; puncture?: boolean }[];
  /** Danni (null = auto intatta) */
  damage: { frontWing: number; rearWing: number; floor: number; suspension: number; engine: number } | null;
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
  private standings: HTMLDivElement;
  private startLights: HTMLDivElement;
  readonly lapList: HTMLDivElement;
  private flag: HTMLDivElement;
  private pitEl: HTMLDivElement;
  private damageEl: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.laps = h('hud-panel hud-laps');
    this.dash = h('hud-panel hud-dash', `
      <div class="shift-lights">${'<span></span>'.repeat(10)}</div>
      <div class="main">
        <div><div class="speed mono">0</div><div class="unit">km/h</div></div>
        <div class="gear mono">N</div>
      </div>
      <div class="rpm mono">0 giri/min</div>
      <div class="aids"><span data-a="abs">ABS</span><span data-a="tc">TC</span><span data-a="auto">AUTO</span><span class="lim">LIMITATORE BOX</span></div>
      <div class="ers"><div class="bat"><i></i><b></b></div><div class="ers-row mono"><span class="mode"></span><span class="kw"></span><span class="ot">OVERTAKE</span><span class="aero">ALI APERTE</span></div></div>`);
    this.inputs = h('hud-panel hud-inputs', `
      <div class="bar brk"><i></i></div><div class="bar thr"><i></i></div><div class="steer"><i></i></div>`);
    this.info = h('hud-panel hud-info');
    this.msg = h('hud-panel hud-msg');
    this.telemetry = h('hud-panel hud-telemetry mono');
    this.standings = h('hud-panel hud-standings');
    this.startLights = h('hud-panel hud-lights', '<span></span>'.repeat(5));
    this.lapList = h('hud-panel hud-laplist mono');
    this.flag = h('hud-panel hud-flag');
    this.pitEl = h('hud-panel hud-pit');
    this.damageEl = h('hud-panel hud-damage');
    this.tyres = h('hud-panel hud-tyres', `<div class="title"></div><div class="grid">${'<div class="tyre"><div class="t mono"></div><div class="p mono"></div><div class="w"><i></i></div></div>'.repeat(4)}</div><div class="fuel mono"></div>`);
    root.append(this.laps, this.standings, this.startLights, this.lapList, this.flag, this.pitEl, this.damageEl, this.dash, this.inputs, this.info, this.msg, this.telemetry, this.tyres);
    this.lights = Array.from(this.dash.querySelectorAll('.shift-lights span'));
  }

  /** Messaggio temporaneo al centro dello schermo. */
  message(text: string, seconds = 2.5): void {
    this.msg.textContent = text;
    this.msg.classList.add('show');
    this.msgTimer = seconds;
  }


  /** Toglie subito il messaggio a schermo. */
  clearMessage(): void {
    this.msgTimer = 0;
    this.msg.classList.remove('show');
  }

  update(d: HudData, frameDt: number): void {
    if (this.msgTimer > 0) {
      this.msgTimer -= frameDt;
      if (this.msgTimer <= 0) this.msg.classList.remove('show');
    }

    // pit stop
    if (d.pit) {
      const txt = d.pit.phase === 'sosta'
        ? `🛠 SOSTA AI BOX<div class="big">${Math.max(0, d.pit.left).toFixed(1)} s</div>`
        : d.pit.phase === 'uscita' ? '🚦 Uscita dai box · limitatore' : '🅿 Corsia box · la squadra ti porta alla piazzola';
      this.pitEl.innerHTML = txt;
      this.pitEl.style.display = 'block';
    } else this.pitEl.style.display = 'none';

    this.renderTiming(d.timing);
    this.renderStandings(d.standings);
    this.startLights.style.display = d.lights >= 0 ? 'flex' : 'none';
    this.startLights.querySelectorAll('span').forEach((l, i) => l.classList.toggle('on', i < d.lights));
    const flagHtml = d.flag === 'blu'
      ? '<span class="f blu"></span> Bandiera blu: lascia passare'
      : d.flag === 'gialla' ? '<span class="f gialla"></span> Bandiera gialla: rallenta' : d.draft ? '💨 In scia' : '';
    this.flag.style.display = flagHtml ? '' : 'none';
    if (this.flag.innerHTML !== flagHtml) this.flag.innerHTML = flagHtml;

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
    aids[3].style.display = d.limiter ? '' : 'none';
    // ---- Monoposto: batteria, modalità, Overtake, aerodinamica attiva ----
    const ersEl = this.dash.querySelector('.ers') as HTMLElement;
    ersEl.style.display = d.ers ? '' : 'none';
    if (d.ers) {
      const e = d.ers;
      (ersEl.querySelector('.bat i') as HTMLElement).style.width = `${Math.round(e.charge * 100)}%`;
      (ersEl.querySelector('.bat b') as HTMLElement).textContent = `🔋 ${Math.round(e.charge * 100)}%`;
      ersEl.querySelector('.bat')!.classList.toggle('low', e.charge < 0.15);
      (ersEl.querySelector('.mode') as HTMLElement).textContent = e.mode;
      const kw = ersEl.querySelector('.kw') as HTMLElement;
      kw.textContent = e.powerKW > 1 ? `+${Math.round(e.powerKW)} kW` : e.powerKW < -1 ? `${Math.round(e.powerKW)} kW` : '';
      kw.className = `kw ${e.powerKW > 1 ? 'dep' : e.powerKW < -1 ? 'har' : ''}`;
      const ot = ersEl.querySelector('.ot') as HTMLElement;
      ot.style.display = e.overtake === 'no' ? 'none' : '';
      ot.className = `ot ${e.overtake === 'attivo' ? 'on' : ''}`;
      ot.textContent = e.overtake === 'attivo' ? 'OVERTAKE ATTIVO' : 'OVERTAKE (O)';
      const aero = ersEl.querySelector('.aero') as HTMLElement;
      aero.style.display = e.aeroOpen > 0.05 || e.aeroZone ? '' : 'none';
      aero.className = `aero ${e.aeroOpen > 0.5 ? 'on' : ''}`;
      aero.textContent = e.aeroOpen > 0.5 ? 'ALI APERTE' : 'ZONA ALI';
    }
    const fuelEl = this.tyres.querySelector('.fuel') as HTMLElement;
    fuelEl.textContent = `⛽ ${d.fuel.toFixed(1)} kg · ~${isFinite(d.fuelLaps) ? Math.floor(d.fuelLaps) : '–'} giri`;
    fuelEl.classList.toggle('low', d.fuelLaps < 2);

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
      c.classList.toggle('punct', !!t.puncture);
      if (t.puncture) (c.querySelector('.p') as HTMLElement).textContent = 'FORATA';
      c.title = `Carcassa ${Math.round(t.core)} °C · battistrada ${(t.tread * 100).toFixed(0)}% · aderenza ${(t.grip * 100).toFixed(0)}%`;
    });

    // danni: una riga per parte, colore dalla gravità
    if (d.damage) {
      const dm = d.damage;
      const row = (name: string, v: number) => v > 0.02
        ? `<div class="dr"><span>${name}</span><i style="width:${Math.round(v * 100)}%;background:${v > 0.6 ? '#ff4d4d' : v > 0.25 ? '#ff9d2e' : '#ffcc00'}"></i><b>${Math.round(v * 100)}%</b></div>` : '';
      this.damageEl.innerHTML = '<div class="title">🔧 Danni</div>' + row('Ala ant.', dm.frontWing) + row('Ala post.', dm.rearWing)
        + row('Fondo', dm.floor) + row('Sospens.', dm.suspension) + row('Motore', dm.engine);
      this.damageEl.style.display = 'block';
    } else this.damageEl.style.display = 'none';

    this.info.innerHTML =`${d.trackName} · ${d.carName}<br>Telecamera: ${d.camera} (C) · Input: ${d.device}<br>H = aiuto · P = pausa`;
  }

  private renderTiming(t: TimingHud): void {
    const lapLabel = t.lap === 0 ? 'Giro di uscita' : `Giro ${t.lap}`;
    let delta = '';
    if (t.delta !== null && t.lap > 0) {
      const cls = t.delta <= 0 ? 'faster' : 'slower';
      delta = `<span class="delta ${cls}" title="rispetto a ${t.deltaRef}">${t.delta <= 0 ? '−' : '+'}${Math.abs(t.delta).toFixed(2)}</span>`;
    }
    const sectors = t.sectors
      .map((s, i) => `<span class="sector ${s.color}">${s.time !== null ? s.time.toFixed(2) : `S${i + 1}`}</span>`)
      .join('');
    this.laps.innerHTML = `
      <div class="row head"><span>${t.sessionName}</span><span class="mono">${t.sessionInfo}</span></div>
      <div class="row"><span class="pos">P${t.position}<small>/${t.total}</small></span><span class="label">${lapLabel}</span>${t.valid ? '' : '<span class="invalid">NON VALIDO</span>'}</div>
      <div class="row current mono ${t.valid ? '' : 'invalid'}">${t.lap === 0 ? '-:--.---' : formatLapTime(t.current)}${delta}</div>
      <div class="sectors">${sectors}</div>
      <div class="row"><span class="label">Ultimo</span><span class="mono">${formatLapTime(t.lastLap)}</span></div>
      <div class="row"><span class="label">Migliore</span><span class="mono green">${formatLapTime(t.bestLap)}</span></div>
      <div class="row"><span class="label">Record</span><span class="mono best">${formatLapTime(t.recordLap)}</span></div>`;
  }

  private renderStandings(rows: StandingRow[]): void {
    this.standings.style.display = rows.length > 1 ? '' : 'none';
    // le prime 12; se il pilota è più indietro, la sua riga prende il posto dell'ultima
    let shown = rows.slice(0, 12);
    const me = rows.find((r) => r.player);
    if (me && !shown.includes(me)) shown = [...rows.slice(0, 11), me];
    this.standings.innerHTML = shown
      .map((r) => `<div class="srow ${r.player ? 'me' : ''}"><span class="p">${r.pos}</span><span class="n">${r.name}</span><span class="g mono">${r.gap}</span></div>`)
      .join('');
  }

  /** Elenco dei giri della sessione (tasto L). */
  showLapList(html: string | null): void {
    if (html === null) {
      this.lapList.style.display = 'none';
      return;
    }
    this.lapList.style.display = 'block';
    this.lapList.innerHTML = html;
  }
}
