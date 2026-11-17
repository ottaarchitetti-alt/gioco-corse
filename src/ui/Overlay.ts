/**
 * Schermate a tutto schermo: avvio, pausa, aiuto comandi.
 */

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
      <p>Fase 2 · Prove libere · ${trackName} · ${carName}</p>
      <h2>Comandi</h2>${CONTROLS}
      <button>Entra in pista</button>`;
    this.el.classList.remove('hidden');
    this.card.querySelector('button')!.addEventListener('click', () => {
      this.hide();
      onStart();
    }, { once: true });
  }

  showPause(onResume: () => void): void {
    this.card.innerHTML = `<h1>Pausa</h1><h2>Comandi</h2>${CONTROLS}<button>Riprendi</button>`;
    this.el.classList.remove('hidden');
    this.card.querySelector('button')!.addEventListener('click', onResume, { once: true });
  }

  showError(text: string): void {
    this.card.innerHTML = `<h1>Errore</h1><p>${text}</p>`;
    this.el.classList.remove('hidden');
  }
}
