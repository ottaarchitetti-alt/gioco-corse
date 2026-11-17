/**
 * Schermate a tutto schermo: avvio, pausa, aiuto comandi.
 */
import { DIFFICULTIES, type Difficulty } from '../ai/BotDriver';
import { GRID_NAMES, JUMP_START_PENALTY, SESSION_NAMES, type GridMode, type SessionConfig, type SessionType } from '../race/Session';
import { navigate } from './router';

const CONTROLS = `
<table>
  <tr><td>↑ / W</td><td>Acceleratore</td></tr>
  <tr><td>↓ / S / Spazio</td><td>Freno</td></tr>
  <tr><td>← → / A D</td><td>Sterzo</td></tr>
  <tr><td>E / Shift sx</td><td>Marcia su</td></tr>
  <tr><td>Q / Ctrl sx</td><td>Marcia giù (da ferma in 1ª → retromarcia)</td></tr>
  <tr><td>C</td><td>Cambia telecamera (esterna, cofano, abitacolo)</td></tr>
  <tr><td>R</td><td>Rimetti l'auto in pista</td></tr>
  <tr><td>L</td><td>Elenco dei giri della sessione (tempi e settori)</td></tr>
  <tr><td>F</td><td>Fantasma del giro migliore on/off (prove e qualifica)</td></tr>
  <tr><td>T</td><td>Telemetria a numeri (carichi, slip, temperature, usura)</td></tr>
  <tr><td>G</td><td>Grafici di telemetria (velocità, pedali, sterzo, g laterali, temperature)</td></tr>
  <tr><td>F2</td><td>Pannello di regolazione (fisica, aiuti, volante)</td></tr>
  <tr><td>M</td><td>Audio on/off</td></tr>
  <tr><td>P / Esc</td><td>Pausa</td></tr>
  <tr><td>H</td><td>Questo aiuto</td></tr>
</table>
<p>Gamepad: stick sinistro sterza, grilletti gas/freno, dorsali per cambiare, Y telecamera.<br>
Volante: si attiva appena lo muovi. Assi e pulsanti si regolano nel pannello F2 → Volante.</p>`;

export class Overlay {
  private el: HTMLDivElement;
  private card: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'overlay';
    this.card = document.createElement('div');
    this.card.className = 'card';
    this.el.appendChild(this.card);
    root.appendChild(this.el);
    this.card.innerHTML = `<h1>Simulatore di corsa</h1><p class="loading">Caricamento…</p>`;
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  /**
   * Schermata iniziale: scelta della sessione.
   * Il click su "Entra in pista" serve anche ad attivare l'audio (regola dei browser).
   */
  showStart(
    trackName: string,
    carName: string,
    recordText: string,
    initial: SessionConfig,
    hasQuali: boolean,
    onStart: (c: SessionConfig) => void,
    onCalibrate: () => void,
    onSetup: () => void,
  ): void {
    const cfg = { ...initial };
    const typeBtn = (t: SessionType) =>
      `<button class="seg ${cfg.type === t ? 'on' : ''}" data-type="${t}">${SESSION_NAMES[t]}</button>`;
    const render = () => {
      const opts =
        cfg.type === 'gara'
          ? `<label>Giri <input type="number" min="1" max="200" value="${cfg.laps}" data-f="laps"></label>
             <p class="small">Partenza da fermo dalla griglia con il semaforo: muoversi prima che si spengano le luci costa ${JUMP_START_PENALTY} s di penalità.</p>`
          : `<label>Durata (minuti${cfg.type === 'libere' ? ', 0 = senza limite' : ''})
               <input type="number" min="${cfg.type === 'libere' ? 0 : 1}" max="180" value="${cfg.minutes}" data-f="minutes"></label>
             <p class="small">${cfg.type === 'qualifica' ? 'Conta il giro valido più veloce. Allo scadere del tempo puoi finire il giro in corso.' : 'Giri liberi per provare pista e assetto. Il fantasma del tuo record ti fa da riferimento (tasto F).'}</p>`;
      const grids = (Object.keys(GRID_NAMES) as GridMode[]).filter((g) => g !== 'qualifica' || hasQuali);
      if (!grids.includes(cfg.grid)) cfg.grid = 'meta';
      const rivals = `
        <label>Avversari <input type="number" min="0" max="19" value="${cfg.opponents}" data-f="opponents"></label>
        <label>Difficoltà <select data-s="difficulty">${(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => `<option value="${d}" ${cfg.difficulty === d ? 'selected' : ''}>${DIFFICULTIES[d].label}</option>`).join('')}</select></label>
        ${cfg.type === 'gara' ? `<label>Partenza <select data-s="grid">${grids.map((g) => `<option value="${g}" ${cfg.grid === g ? 'selected' : ''}>${GRID_NAMES[g]}</option>`).join('')}</select></label>` : ''}`;
      this.card.innerHTML = `
        <h1>${trackName}</h1>
        <p>${carName} · Record: <b>${recordText}</b></p>
        <h2>Sessione</h2>
        <div class="segs">${(['libere', 'qualifica', 'gara'] as SessionType[]).map(typeBtn).join('')}</div>
        <div class="form">${opts}</div>
        <h2>Avversari</h2>
        <div class="form">${rivals}</div>
        <h2>Strategia</h2>
        <div class="form">
          <label>Usura gomme × <input type="number" min="0" max="10" step="0.5" value="${cfg.wearMultiplier}" data-m="wearMultiplier"></label>
          <label>Consumo carburante × <input type="number" min="0" max="10" step="0.5" value="${cfg.fuelMultiplier}" data-m="fuelMultiplier"></label>
          <p class="small">1 = realistico. Valori più alti rendono le soste necessarie anche in gare brevi.</p>
        </div>
        <div class="actions"><button data-go>Entra in pista</button><button class="secondary" data-setup>🔧 Assetto</button><button class="secondary" data-cal>🎮 Calibra volante</button><button class="secondary" data-menu>◀ Menu</button></div>
        <h2>Comandi</h2>${CONTROLS}`;
      this.card.querySelectorAll<HTMLButtonElement>('[data-type]').forEach((b) =>
        b.addEventListener('click', () => {
          cfg.type = b.dataset.type as SessionType;
          if (cfg.type === 'qualifica' && cfg.minutes <= 0) cfg.minutes = 10;
          render();
        }),
      );
      this.card.querySelectorAll<HTMLInputElement>('[data-f]').forEach((el) =>
        el.addEventListener('change', () => {
          const v = Math.max(0, Math.round(parseFloat(el.value) || 0));
          if (el.dataset.f === 'laps') cfg.laps = Math.max(1, v);
          else if (el.dataset.f === 'opponents') cfg.opponents = Math.min(19, v);
          else cfg.minutes = cfg.type === 'libere' ? v : Math.max(1, v);
        }),
      );
      this.card.querySelectorAll<HTMLSelectElement>('[data-s]').forEach((el) =>
        el.addEventListener('change', () => {
          if (el.dataset.s === 'difficulty') cfg.difficulty = el.value as Difficulty;
          else cfg.grid = el.value as GridMode;
        }),
      );
      this.card.querySelector('[data-cal]')!.addEventListener('click', onCalibrate);
      this.card.querySelector('[data-setup]')!.addEventListener('click', onSetup);
      this.card.querySelectorAll<HTMLInputElement>('[data-m]').forEach((el) =>
        el.addEventListener('change', () => {
          const v = Math.max(0, parseFloat(el.value.replace(',', '.')) || 0);
          if (el.dataset.m === 'wearMultiplier') cfg.wearMultiplier = v;
          else cfg.fuelMultiplier = v;
        }),
      );
      this.card.querySelector('[data-menu]')!.addEventListener('click', () => navigate('menu'));
      this.card.querySelector('[data-go]')!.addEventListener('click', () => {
        // legge anche un campo modificato senza aver premuto Invio
        this.card.querySelectorAll<HTMLInputElement>('[data-f],[data-m]').forEach((el) => el.dispatchEvent(new Event('change')));
        this.hide();
        onStart(cfg);
      }, { once: true });
    };
    render();
    this.el.classList.remove('hidden');
  }

  /** Risultati di fine sessione. */
  showResults(title: string, html: string, actions: { label: string; act: () => void; primary?: boolean }[]): void {
    this.card.innerHTML = `<h1>${title}</h1>${html}
      <div class="actions">${actions.map((a, i) => `<button class="${a.primary ? '' : 'secondary'}" data-i="${i}">${a.label}</button>`).join('')}</div>`;
    this.el.classList.remove('hidden');
    this.card.querySelectorAll<HTMLButtonElement>('button[data-i]').forEach((b) =>
      b.addEventListener('click', () => actions[parseInt(b.dataset.i!)].act(), { once: true }),
    );
  }

  showPause(onResume: () => void, extra: { label: string; act: () => void }[] = []): void {
    this.card.innerHTML = `<h1>Pausa</h1>
      <div class="actions"><button data-i="-1">Riprendi</button>${extra.map((e, i) => `<button class="secondary" data-i="${i}">${e.label}</button>`).join('')}</div>
      <h2>Comandi</h2>${CONTROLS}`;
    this.el.classList.remove('hidden');
    this.card.querySelectorAll<HTMLButtonElement>('button[data-i]').forEach((b) =>
      b.addEventListener('click', () => {
        const i = parseInt(b.dataset.i!);
        if (i < 0) onResume();
        else extra[i].act();
      }, { once: true }),
    );
  }

  showError(text: string): void {
    this.card.innerHTML = `<h1>Errore</h1><p>${text}</p>`;
    this.el.classList.remove('hidden');
  }
}
