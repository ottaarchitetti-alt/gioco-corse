/**
 * Punto di ingresso: sceglie la schermata in base all'indirizzo.
 *   #/menu                    menu principale (default)
 *   #/guida?pista=ID          guida sulla pista ID
 *   #/editor?pista=ID         editor della pista ID
 *   #/carriera[?id=ID]        modalità carriera (elenco o carriera ID)
 *   #/guida?pista=ID&carriera=ID   weekend di gara della carriera
 */
import './ui/hud.css';
import './ui/menu.css';
import './editor/editor.css';
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/700.css';
import './ui/pixel.css';
import { loadSettings } from './ui/Settings';
import { currentRoute, installRouter, navigate } from './ui/router';

const app = document.getElementById('app')!;
// stile grafico scelto nelle impostazioni (pixel art o realistico): vale anche per i menu
document.body.classList.toggle('pixel-style', loadSettings().style === 'pixel');
const ui = document.getElementById('ui')!;

function showError(err: unknown): void {
  console.error(err);
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;color:#fff;font:16px sans-serif;background:#111;pointer-events:auto';
  box.textContent = `Errore: ${err instanceof Error ? err.message : String(err)}`;
  const back = document.createElement('button');
  back.textContent = '◀ Torna al menu';
  back.onclick = () => navigate('menu');
  box.appendChild(back);
  document.body.appendChild(box);
}

async function start(): Promise<void> {
  installRouter();
  const { route, params } = currentRoute();
  const trackId = params.get('pista');

  if (route === 'guida' && trackId) {
    const { Game } = await import('./game/Game');
    const game = new Game(app, ui, trackId, params.get('da') === 'editor', params.get('auto'), params.get('carriera'));
    // Solo in sviluppo: il gioco è ispezionabile dalla console del browser (window.game, devTools)
    if (import.meta.env.DEV) {
      (window as unknown as { game: unknown }).game = game;
      void import('./dev/devTools').then((m) => m.installDevTools(game));
    }
    await game.init();
    return;
  }

  if (route === 'editor' && trackId) {
    const [{ Editor }, { TrackStore }] = await Promise.all([import('./editor/Editor'), import('./storage/TrackStore')]);
    if (await TrackStore.isBuiltin(trackId)) throw new Error('Le piste incluse non si modificano: usa "Copia e modifica" dal menu.');
    const data = await TrackStore.load(trackId);
    const editor = new Editor(ui, data);
    if (import.meta.env.DEV) (window as unknown as { editor: unknown }).editor = editor;
    await editor.init();
    return;
  }

  if (route === 'carriera') {
    const { CareerScreen } = await import('./career/CareerScreen');
    await new CareerScreen(ui).show(params.get('id'));
    return;
  }

  const { MainMenu } = await import('./ui/MainMenu');
  await new MainMenu(ui).show();
}

start().catch(showError);
