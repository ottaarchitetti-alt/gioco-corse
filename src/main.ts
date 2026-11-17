/**
 * Punto di ingresso. Crea il gioco e mostra un errore leggibile se qualcosa va storto.
 */
import './ui/hud.css';
import { Game } from './game/Game';

const app = document.getElementById('app')!;
const ui = document.getElementById('ui')!;

const game = new Game(app, ui);
// Solo in sviluppo: il gioco è ispezionabile dalla console del browser (window.game)
if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
game.init().catch((err) => {
  console.error(err);
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font:16px sans-serif;background:#111';
  box.textContent = `Errore all'avvio: ${err instanceof Error ? err.message : String(err)}`;
  document.body.appendChild(box);
});
