/**
 * Schermate a tutto schermo: avvio, pausa, aiuto comandi.
 */
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

  /** Schermata iniziale: il click serve anche ad attivare l'audio (regola dei browser). */
  showStart(trackName: string, carName: string, onStart: () => void): void {
    this.card.innerHTML = `
      <h1>Simulatore di corsa</h1>
      <p>Prove libere · ${trackName} · ${carName}</p>
      <h2>Comandi</h2>${CONTROLS}
      <div class="actions"><button data-go>Entra in pista</button><button class="secondary" data-menu>◀ Menu</button></div>`;
    this.el.classList.remove('hidden');
    this.card.querySelector('[data-menu]')!.addEventListener('click', () => navigate('menu'));
    this.card.querySelector('[data-go]')!.addEventListener('click', () => {
      this.hide();
      onStart();
    }, { once: true });
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
