/**
 * Navigazione tra le schermate tramite l'indirizzo (#/menu, #/guida, #/editor, #/carriera).
 * Cambiare schermata ricarica la pagina: ogni schermata parte "pulita"
 * (niente risorse 3D o eventi rimasti appesi dalla schermata precedente).
 */

export type Route = 'menu' | 'guida' | 'editor' | 'carriera';

export function currentRoute(): { route: Route; params: URLSearchParams } {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const route: Route = path === 'guida' || path === 'editor' || path === 'carriera' ? path : 'menu';
  return { route, params: new URLSearchParams(query ?? '') };
}

export function navigate(route: Route, params: Record<string, string> = {}): void {
  const q = new URLSearchParams(params).toString();
  location.hash = `#/${route}${q ? '?' + q : ''}`;
}

/** Ricarica quando cambia l'indirizzo (anche con i tasti avanti/indietro del browser). */
export function installRouter(): void {
  window.addEventListener('hashchange', () => location.reload());
}
