/**
 * CALIBRAZIONE GUIDATA DEL VOLANTE (es. Logitech G29).
 *
 * Invece di indovinare quale asse è il freno o se un pedale è "invertito",
 * misuriamo il volante vero, un passo alla volta:
 *   1. scelta del dispositivo
 *   2. volante dritto e pedali rilasciati → posizione di riposo di tutti gli assi
 *   3. gira tutto a sinistra e a destra → quale asse è lo sterzo
 *   4. un quarto di giro (90°) a sinistra → verso e gradi totali di rotazione
 *   5. acceleratore e 6. freno: premi e rilascia → asse, riposo e fondo corsa
 *   7. palette → pulsanti marcia su / giù; poi i tasti batteria su / giù (monoposto)
 *   8. prova dal vivo e regolazioni (modalità sterzo, linearità, zone morte)
 *
 * In ogni passo "Avanti" si può premere anche con un pulsante del volante
 * (tranne quando si stanno rilevando le palette).
 */
import type { InputManager, PedalCalibration, SteerMode } from './InputManager';

type Step = 'device' | 'center' | 'sweep' | 'quarter' | 'throttle' | 'brake' | 'up' | 'down' | 'ersUp' | 'ersDown' | 'test';
const ORDER: Step[] = ['device', 'center', 'sweep', 'quarter', 'throttle', 'brake', 'up', 'down', 'ersUp', 'ersDown', 'test'];
/** passi in cui si registra un pulsante */
const BUTTON_STEPS: Step[] = ['up', 'down', 'ersUp', 'ersDown'];

const TEXT: Record<Step, { title: string; body: string }> = {
  device: { title: 'Dispositivo', body: 'Scegli il volante dall\'elenco. Se non compare, muovilo o premi un suo pulsante (il browser lo "vede" solo dopo un input).' },
  center: { title: 'Posizione di riposo', body: 'Tieni il volante <b>dritto</b> e i pedali <b>completamente rilasciati</b>. Poi premi Avanti.' },
  sweep: { title: 'Asse dello sterzo', body: 'Gira il volante <b>tutto a sinistra</b>, poi <b>tutto a destra</b>, poi rimettilo dritto. Poi premi Avanti.' },
  quarter: { title: 'Gradi di rotazione', body: 'Gira il volante di <b>esattamente un quarto di giro (90°) a SINISTRA</b> — le razze orizzontali diventano verticali — e tienilo lì. Poi premi Avanti con il mouse.' },
  throttle: { title: 'Acceleratore', body: 'Premi e rilascia l\'<b>acceleratore</b> un paio di volte fino in fondo, poi <b>tienilo premuto a fondo</b> e premi Avanti con il mouse.' },
  brake: { title: 'Freno', body: 'Premi e rilascia il <b>freno</b> un paio di volte fino in fondo, poi <b>tienilo premuto a fondo</b> e premi Avanti con il mouse.' },
  up: { title: 'Paletta marcia su', body: 'Premi la <b>paletta DESTRA</b> (marcia su).' },
  down: { title: 'Paletta marcia giù', body: 'Premi la <b>paletta SINISTRA</b> (marcia giù).' },
  ersUp: { title: 'Batteria su (monoposto)', body: 'Premi il tasto che vuoi usare per <b>alzare</b> la modalità della batteria (ricarica → bilanciata → attacco). Sul G29 di solito il <b>cerchio</b>.' },
  ersDown: { title: 'Batteria giù (monoposto)', body: 'Premi il tasto che vuoi usare per <b>abbassare</b> la modalità della batteria (attacco → bilanciata → ricarica). Sul G29 di solito il <b>triangolo</b>.' },
  test: { title: 'Prova e regolazioni', body: 'Muovi volante e pedali: le barre devono seguire i tuoi movimenti. Regola se serve, poi Salva.' },
};

export class WheelCalibration {
  private el: HTMLDivElement;
  private step: Step = 'device';
  private timer = 0;
  private pad: Gamepad | null = null;
  private padId = '';
  private baseline: number[] = [];
  private min: number[] = [];
  private max: number[] = [];
  private prevButtons: boolean[] = [];
  private steerAxis = 0;
  private msg = '';
  /** copia delle impostazioni: si applicano solo con "Salva" */
  private draft: InputManager['wheel'];

  constructor(private input: InputManager, private onClose: () => void = () => {}) {
    this.el = document.createElement('div');
    this.el.className = 'overlay wheel-cal';
    document.body.appendChild(this.el);
    this.draft = structuredClone(input.wheel);
    this.padId = this.draft.deviceId;
  }

  open(): void {
    this.input.suspended = true;
    this.render();
    // aggiornamento a 30 Hz (setInterval: funziona anche se la scheda non è in primo piano)
    this.timer = window.setInterval(() => this.tick(), 33);
  }

  private close(): void {
    clearInterval(this.timer);
    this.input.suspended = false;
    this.el.remove();
    this.onClose();
  }

  private currentPad(): Gamepad | null {
    const pads = this.input.listPads();
    return pads.find((p) => p.id === this.padId) ?? null;
  }

  private resetTracking(): void {
    const p = this.pad;
    if (!p) return;
    this.min = Array.from(p.axes);
    this.max = Array.from(p.axes);
    this.prevButtons = p.buttons.map((b) => b.pressed);
  }

  private tick(): void {
    this.pad = this.currentPad();
    const p = this.pad;
    if (this.step === 'device') {
      // aggiorna l'elenco se cambia il numero di dispositivi
      const ids = this.input.listPads().map((x) => x.id).join('|');
      if (ids !== this.el.dataset.ids) this.render();
      return;
    }
    if (!p) {
      this.setLive('<span class="bad">Dispositivo non trovato: è ancora collegato?</span>');
      return;
    }
    p.axes.forEach((a, i) => {
      this.min[i] = Math.min(this.min[i] ?? a, a);
      this.max[i] = Math.max(this.max[i] ?? a, a);
    });
    const pressed = p.buttons.map((b) => b.pressed);
    const newPress = pressed.findIndex((b, i) => b && !this.prevButtons[i]);
    this.prevButtons = pressed;

    if (BUTTON_STEPS.includes(this.step)) {
      if (newPress >= 0) {
        if (this.step === 'up') this.draft.shiftUpButton = newPress;
        else if (this.step === 'down') this.draft.shiftDownButton = newPress;
        else if (this.step === 'ersUp') this.draft.ersModeButton = newPress;
        else this.draft.ersDownButton = newPress;
        this.msg = `Pulsante ${newPress} registrato.`;
        this.next();
      }
      return;
    }
    // negli altri passi un pulsante del volante vale come "Avanti" (non dove serve tenere un pedale)
    if (newPress >= 0 && (this.step === 'center' || this.step === 'sweep' || this.step === 'test')) {
      if (this.step === 'test') return; // in prova i pulsanti si provano e basta
      this.next();
      return;
    }
    this.setLive(this.liveHtml(p));
  }

  /** Conclude il passo attuale (misure) e passa al successivo. */
  private next(): void {
    const p = this.pad;
    const d = this.draft;
    this.msg = '';
    switch (this.step) {
      case 'device':
        if (!this.padId) return this.flash('Scegli un dispositivo.');
        this.pad = this.currentPad();
        d.deviceId = this.padId;
        break;
      case 'center':
        if (!p) return this.flash('Dispositivo non trovato.');
        this.baseline = Array.from(p.axes);
        break;
      case 'sweep': {
        // l'asse con l'escursione più ampia è lo sterzo
        let best = -1, range = 0;
        this.min.forEach((mn, i) => {
          const r = this.max[i] - mn;
          if (r > range) { range = r; best = i; }
        });
        if (best < 0 || range < 0.5) return this.flash('Non ho rilevato abbastanza movimento: gira il volante fino in fondo da entrambi i lati.');
        this.steerAxis = best;
        d.steerAxis = best;
        d.steerCenter = this.baseline[best] ?? 0;
        break;
      }
      case 'quarter': {
        const v = p!.axes[this.steerAxis] - d.steerCenter;
        if (Math.abs(v) < 0.05) return this.flash('Il volante sembra dritto: giralo di 90° a sinistra e tienilo lì.');
        d.invertSteer = v > 0; // se a sinistra l'asse cresce, va invertito
        // ±1 = metà rotazione → 90° corrispondono a |v| · (rotazione/2)
        d.hardwareLockDeg = Math.round(Math.min(1080, Math.max(180, 180 / Math.abs(v))) / 10) * 10;
        this.msg = `Rotazione misurata: ${d.hardwareLockDeg}°.`;
        break;
      }
      case 'throttle':
      case 'brake': {
        const cal = this.pedalFrom(p!, this.step === 'brake' ? d.throttle.axis : -1);
        if (!cal) return this.flash('Non ho rilevato il pedale: premilo fino in fondo un paio di volte e tienilo premuto.');
        if (this.step === 'throttle') d.throttle = cal;
        else d.brake = cal;
        this.msg = `Pedale sull'asse ${cal.axis} (riposo ${cal.rest.toFixed(2)}, fondo ${cal.full.toFixed(2)}).`;
        break;
      }
      case 'test':
        return;
    }
    this.step = ORDER[ORDER.indexOf(this.step) + 1];
    this.resetTracking();
    this.render();
  }

  /** Il pedale è l'asse (diverso dallo sterzo) con l'escursione maggiore; "fondo" = valore attuale. */
  private pedalFrom(p: Gamepad, exclude: number): PedalCalibration | null {
    let best = -1, range = 0;
    this.min.forEach((mn, i) => {
      if (i === this.steerAxis || i === exclude) return;
      const r = this.max[i] - mn;
      if (r > range) { range = r; best = i; }
    });
    if (best < 0 || range < 0.4) return null;
    const full = p.axes[best];
    // il riposo è l'estremo opposto a quello in cui il pedale è tenuto adesso
    const rest = Math.abs(full - this.min[best]) > Math.abs(full - this.max[best]) ? this.min[best] : this.max[best];
    if (Math.abs(full - rest) < 0.4) return null;
    return { axis: best, rest, full };
  }

  private flash(text: string): void {
    this.msg = `<span class="bad">${text}</span>`;
    this.render();
  }

  private skip(): void {
    this.msg = '';
    this.step = ORDER[ORDER.indexOf(this.step) + 1];
    this.resetTracking();
    this.render();
  }

  private save(): void {
    Object.assign(this.input.wheel, this.draft, { calibrated: true });
    this.input.saveWheelSettings();
    this.close();
  }

  // ------------------------------------------------------------------ vista

  private setLive(html: string): void {
    const live = this.el.querySelector('.live');
    if (live) live.innerHTML = html;
  }

  private liveHtml(p: Gamepad): string {
    if (this.step === 'test') {
      // usa la bozza per la prova dal vivo
      const saved = this.input.wheel;
      const tmp = structuredClone(saved);
      Object.assign(saved, this.draft);
      const deg = this.input.wheelDegrees(p.axes[this.draft.steerAxis] ?? 0);
      const steer = this.input.steerFromDegrees(deg);
      const thr = this.input.pedalValue(this.draft.throttle, p.axes[this.draft.throttle.axis]);
      const brk = this.input.pedalValue(this.draft.brake, p.axes[this.draft.brake.axis]);
      Object.assign(saved, tmp);
      const btns = p.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0);
      const shiftTxt = btns.includes(this.draft.shiftUpButton) ? 'MARCIA SU' : btns.includes(this.draft.shiftDownButton) ? 'MARCIA GIÙ'
        : btns.includes(this.draft.ersModeButton) ? 'BATTERIA SU' : btns.includes(this.draft.ersDownButton) ? 'BATTERIA GIÙ' : '';
      return `
        <div class="meter"><span>Volante</span><b class="mono">${deg >= 0 ? 'sx' : 'dx'} ${Math.abs(deg).toFixed(0)}°</b></div>
        <div class="steerbar"><i style="left:${(0.5 - steer / 2) * 100}%"></i></div>
        <div class="meter"><span>Sterzo auto</span><b class="mono">${(steer * 100).toFixed(0)}%</b></div>
        <div class="meter"><span>Acceleratore</span><div class="pbar"><i style="width:${thr * 100}%;background:#3ddc84"></i></div></div>
        <div class="meter"><span>Freno</span><div class="pbar"><i style="width:${brk * 100}%;background:#ff4d4d"></i></div></div>
        <div class="meter"><span>Pulsanti</span><b>${shiftTxt}</b></div>`;
    }
    const axes = Array.from(p.axes).map((a, i) => {
      const hl = this.step === 'quarter' && i === this.steerAxis ? ' hl' : '';
      return `<div class="axis${hl}"><span>asse ${i}</span><div class="pbar"><i style="width:${((a + 1) / 2) * 100}%"></i></div><b class="mono">${a.toFixed(2)}</b></div>`;
    }).join('');
    return axes;
  }

  private render(): void {
    const t = TEXT[this.step];
    const n = ORDER.indexOf(this.step) + 1;
    const d = this.draft;
    let content = '';
    if (this.step === 'device') {
      const pads = this.input.listPads();
      this.el.dataset.ids = pads.map((p) => p.id).join('|');
      if (!this.padId && pads.length) this.padId = (pads.find((p) => this.input.isWheel(p)) ?? pads[0]).id;
      content = pads.length
        ? pads.map((p) => `<label class="row"><input type="radio" name="pad" value="${p.id.replace(/"/g, '&quot;')}" ${p.id === this.padId ? 'checked' : ''}> ${p.id}</label>`).join('')
        : '<p class="bad">Nessun dispositivo rilevato. Collega il volante e muovilo.</p>';
    } else if (this.step === 'test') {
      content = `
        <div class="live"></div>
        <label>Modalità sterzo
          <select data-k="steerMode">
            <option value="reale" ${d.steerMode === 'reale' ? 'selected' : ''}>Reale 1:1 (consigliato: in G HUB imposta ${this.input.carSteeringLockDeg}°)</option>
            <option value="scalato" ${d.steerMode === 'scalato' ? 'selected' : ''}>Scalata: tutta la corsa del volante = tutta la corsa dell'auto</option>
          </select></label>
        <label>Rotazione del volante fisico (°) <input type="number" min="180" max="1080" step="10" data-k="hardwareLockDeg" value="${d.hardwareLockDeg}"></label>
        <label>Linearità sterzo: <b>${d.steerLinearity.toFixed(2)}</b> (1 = lineare, più alto = meno sensibile al centro)
          <input type="range" min="1" max="2" step="0.05" data-k="steerLinearity" value="${d.steerLinearity}"></label>
        <label>Zona morta sterzo (°) <input type="number" min="0" max="10" step="0.5" data-k="steerDeadzoneDeg" value="${d.steerDeadzoneDeg}"></label>
        <label>Zona morta pedali (%) <input type="number" min="0" max="20" step="1" data-k="pedalDeadzone" value="${Math.round(d.pedalDeadzone * 100)}"></label>
        <p class="small">Assi: sterzo ${d.steerAxis}, acceleratore ${d.throttle.axis}, freno ${d.brake.axis} · Palette: su ${d.shiftUpButton}, giù ${d.shiftDownButton} · Batteria: su ${d.ersModeButton}, giù ${d.ersDownButton}${this.input.carSteeringLockDeg !== d.hardwareLockDeg && d.steerMode === 'reale' ? `<br>⚠ Il tuo volante ruota ${d.hardwareLockDeg}°, quello dell'auto ${this.input.carSteeringLockDeg}°: in modalità reale oltre ±${this.input.carSteeringLockDeg / 2}° lo sterzo è a fine corsa.` : ''}</p>`;
    } else {
      content = '<div class="live axes"></div>';
    }
    const canSkip = BUTTON_STEPS.includes(this.step);
    this.el.innerHTML = `
      <div class="card">
        <h1>🎮 Calibrazione volante <small>${n}/${ORDER.length}</small></h1>
        <h2>${t.title}</h2>
        <p>${t.body}</p>
        ${content}
        <p class="msg">${this.msg}</p>
        <div class="actions">
          ${this.step === 'test' ? '<button data-a="save">💾 Salva</button>' : BUTTON_STEPS.includes(this.step) ? '' : '<button data-a="next">Avanti ▶</button>'}
          ${canSkip ? '<button class="secondary" data-a="skip">Salta</button>' : ''}
          ${this.step !== 'device' ? '<button class="secondary" data-a="restart">↺ Ricomincia</button>' : ''}
          <button class="secondary" data-a="close">Annulla</button>
        </div>
      </div>`;
    const act: Record<string, () => void> = {
      next: () => this.next(),
      skip: () => this.skip(),
      save: () => this.save(),
      close: () => this.close(),
      restart: () => {
        this.step = 'device';
        this.msg = '';
        this.render();
      },
    };
    this.el.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) => b.addEventListener('click', act[b.dataset.a!]));
    this.el.querySelectorAll<HTMLInputElement>('input[name="pad"]').forEach((r) =>
      r.addEventListener('change', () => { this.padId = r.value; }),
    );
    this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) =>
      el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
        const k = el.dataset.k!;
        if (k === 'steerMode') d.steerMode = el.value as SteerMode;
        else if (k === 'pedalDeadzone') d.pedalDeadzone = Math.max(0, parseFloat(el.value) || 0) / 100;
        else (d as unknown as Record<string, number>)[k] = parseFloat(el.value) || 0;
        if (k !== 'steerLinearity') this.render();
        else (el.parentElement!.querySelector('b') as HTMLElement).textContent = d.steerLinearity.toFixed(2);
      }),
    );
  }
}
