/**
 * IMPOSTAZIONI generali (grafica e audio), salvate nel browser.
 * Si aprono dal menu principale o dal menu di pausa.
 *
 * Qualità grafica:
 *   bassa → niente ombre, risoluzione 1×, pochi alberi   (PC lenti / portatili)
 *   media → ombre 1024, risoluzione fino a 1,5×
 *   alta  → ombre 2048, risoluzione fino a 2×          (consigliata se fluida)
 */
import { loadJSON, saveJSON } from '../core/storage';
import type { PixelSize } from '../render/PixelArt';

export type Quality = 'bassa' | 'media' | 'alta';
export type GraphicStyle = 'pixel' | 'realistico';

export interface GameSettings {
  quality: Quality;
  showFps: boolean;
  /** volume generale (0..1) */
  volume: number;
  /** volume dei motori degli avversari (0..1) */
  opponentVolume: number;
  /** stile grafico e grandezza dei pixel (pixel art) */
  style: GraphicStyle;
  pixelSize: PixelSize;
}

const DEFAULTS: GameSettings = { quality: 'alta', showFps: false, volume: 0.5, opponentVolume: 0.6, style: 'realistico', pixelSize: 'medio' };
/** versione delle impostazioni grafiche: con la 2 lo stile predefinito torna "realistico" */
const STYLE_VERSION = 2;

export function loadSettings(): GameSettings {
  const raw = loadJSON<Partial<GameSettings> & { styleVersion?: number }>('settings', DEFAULTS);
  const s = { ...DEFAULTS, ...raw };
  if ((raw.styleVersion ?? 1) < STYLE_VERSION) {
    // la pixel art era diventata predefinita: si torna alla grafica di prima (resta selezionabile)
    s.style = 'realistico';
    saveJSON('settings', { ...s, styleVersion: STYLE_VERSION });
  }
  return s;
}

export function saveSettings(s: GameSettings): void {
  saveJSON('settings', { ...s, styleVersion: STYLE_VERSION });
}

/** Parametri grafici derivati dalla qualità */
export function qualityParams(q: Quality) {
  return {
    shadows: q !== 'bassa',
    shadowMap: q === 'alta' ? 2048 : 1024,
    pixelRatio: Math.min(window.devicePixelRatio || 1, q === 'alta' ? 2 : q === 'media' ? 1.5 : 1),
    treeFactor: q === 'bassa' ? 0.35 : q === 'media' ? 0.7 : 1,
  };
}

/** Finestra delle impostazioni. `onChange` viene chiamato a ogni modifica (anteprima immediata). */
export function openSettings(s: GameSettings, onChange: (s: GameSettings) => void, onClose: () => void = () => {}): void {
  const el = document.createElement('div');
  el.className = 'overlay settings';
  document.body.appendChild(el);
  const render = () => {
    el.innerHTML = `
      <div class="card">
        <h1>⚙ Impostazioni</h1>
        <h2>Stile grafico</h2>
        <div class="segs">${(['pixel', 'realistico'] as GraphicStyle[]).map((st) => `<button class="seg ${s.style === st ? 'on' : ''}" data-st="${st}">${st === 'pixel' ? 'Pixel art' : 'Realistico'}</button>`).join('')}</div>
        ${s.style === 'pixel' ? `<div class="segs">${(['fine', 'medio', 'grosso'] as PixelSize[]).map((p) => `<button class="seg ${s.pixelSize === p ? 'on' : ''}" data-px="${p}">Pixel ${p}</button>`).join('')}</div>
        <p class="small">Pixel fine = più dettagli, grosso = più "retrò".</p>` : ''}
        <h2>Qualità</h2>
        <div class="segs">${(['bassa', 'media', 'alta'] as Quality[]).map((q) => `<button class="seg ${s.quality === q ? 'on' : ''}" data-q="${q}">${q[0].toUpperCase() + q.slice(1)}</button>`).join('')}</div>
        <p class="small">Se il gioco "scatta", abbassa la qualità. La densità degli alberi cambia dalla prossima pista caricata.</p>
        <div class="form"><label class="row"><input type="checkbox" data-k="showFps" ${s.showFps ? 'checked' : ''}> Mostra FPS (fotogrammi al secondo)</label></div>
        <h2>Audio</h2>
        <div class="form">
          <label>Volume generale <input type="range" min="0" max="1" step="0.05" value="${s.volume}" data-k="volume"></label>
          <label>Motori degli avversari <input type="range" min="0" max="1" step="0.05" value="${s.opponentVolume}" data-k="opponentVolume"></label>
        </div>
        <div class="actions"><button data-a="close">Chiudi</button></div>
      </div>`;
    el.querySelectorAll<HTMLButtonElement>('[data-st]').forEach((b) =>
      b.addEventListener('click', () => { s.style = b.dataset.st as GraphicStyle; saveSettings(s); onChange(s); render(); }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-px]').forEach((b) =>
      b.addEventListener('click', () => { s.pixelSize = b.dataset.px as PixelSize; saveSettings(s); onChange(s); render(); }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) =>
      b.addEventListener('click', () => { s.quality = b.dataset.q as Quality; saveSettings(s); onChange(s); render(); }),
    );
    el.querySelectorAll<HTMLInputElement>('[data-k]').forEach((i) =>
      i.addEventListener(i.type === 'range' ? 'input' : 'change', () => {
        const k = i.dataset.k as keyof GameSettings;
        if (k === 'showFps') s.showFps = i.checked;
        else (s as unknown as Record<string, number>)[k] = parseFloat(i.value);
        saveSettings(s);
        onChange(s);
      }),
    );
    el.querySelector('[data-a="close"]')!.addEventListener('click', () => { el.remove(); onClose(); });
  };
  render();
}
