/**
 * Salvataggio locale semplice (localStorage) per impostazioni e record.
 * Ogni accesso è protetto da try/catch: in navigazione privata o con
 * storage disabilitato il gioco funziona comunque, solo senza salvare.
 * (Dalla Fase 3 piste e assetti andranno in IndexedDB, che ha più spazio.)
 */

const PREFIX = 'simcorsa.';

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return { ...fallback, ...JSON.parse(raw) } as T;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage non disponibile: ignoriamo */
  }
}
