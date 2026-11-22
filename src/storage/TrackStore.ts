/**
 * Archivio delle piste.
 *   - piste INCLUSE: file in public/tracks, elencati in public/tracks/index.json
 *     (sola lettura: per modificarle l'editor ne crea una copia)
 *   - piste TUE: salvate in IndexedDB dall'editor
 */
import { migrateTrack, validateTrackData, type TrackData } from '../track/TrackData';
import { dbAll, dbDelete, dbGet, dbPut } from './db';

export interface TrackInfo {
  id: string;
  name: string;
  builtin: boolean;
  updated?: number;
  /** Gruppo nel menu (es. "Calendario 2026") */
  group?: string;
  lengthM?: number;
}

interface BuiltinEntry {
  id: string;
  name: string;
  file: string;
  group?: string;
  lengthM?: number;
}

interface StoredTrack {
  data: TrackData;
  updated: number;
}

/** Sfondo dell'editor (immagine da ricalcare), salvato insieme alla pista. */
export interface TrackBackground {
  dataUrl: string;
  /** metri per pixel dell'immagine */
  scale: number;
  /** posizione nel mondo dell'angolo in alto a sinistra */
  x: number;
  z: number;
  opacity: number;
}

let builtinCache: BuiltinEntry[] | null = null;

async function builtins(): Promise<BuiltinEntry[]> {
  if (!builtinCache) {
    const res = await fetch('tracks/index.json', { cache: 'no-cache' });
    builtinCache = res.ok ? ((await res.json()) as BuiltinEntry[]) : [];
  }
  return builtinCache;
}

export const TrackStore = {
  async list(): Promise<TrackInfo[]> {
    const b = (await builtins()).map((e) => ({ id: e.id, name: e.name, builtin: true, group: e.group, lengthM: e.lengthM }));
    let user: TrackInfo[] = [];
    try {
      const stored = await dbAll<StoredTrack>('tracks');
      user = stored
        .map((s) => ({ id: s.data.id, name: s.data.name, builtin: false, updated: s.updated }))
        .sort((a, b2) => (b2.updated ?? 0) - (a.updated ?? 0));
    } catch (e) {
      console.warn('IndexedDB non disponibile:', e);
    }
    return [...user, ...b];
  },

  async isBuiltin(id: string): Promise<boolean> {
    return (await builtins()).some((e) => e.id === id);
  },

  async load(id: string): Promise<TrackData> {
    const b = (await builtins()).find((e) => e.id === id);
    let data: TrackData;
    if (b) {
      const res = await fetch(`tracks/${b.file}`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`Pista non trovata: ${b.file}`);
      data = migrateTrack(await res.json());
    } else {
      const stored = await dbGet<StoredTrack>('tracks', id);
      if (!stored) throw new Error(`Pista non trovata: ${id}`);
      data = migrateTrack(stored.data);
    }
    validateTrackData(data);
    return data;
  },

  async save(data: TrackData): Promise<void> {
    await dbPut('tracks', data.id, { data, updated: Date.now() } satisfies StoredTrack);
  },

  async remove(id: string): Promise<void> {
    await dbDelete('tracks', id);
    await dbDelete('backgrounds', id);
  },

  loadBackground: (id: string) => dbGet<TrackBackground>('backgrounds', id),
  saveBackground: (id: string, bg: TrackBackground) => dbPut('backgrounds', id, bg),
  removeBackground: (id: string) => dbDelete('backgrounds', id),

  /** Nuovo identificativo univoco per una pista dell'utente. */
  newId(): string {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  },
};

/** Scarica una pista come file .json */
export function downloadTrack(data: TrackData): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${data.name.replace(/[^\w\-àèéìòù ]+/gi, '').trim() || 'pista'}.track.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Chiede un file .json all'utente e lo converte in pista (con nuovo id). */
export function pickTrackFile(): Promise<TrackData> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) return reject(new Error('Nessun file scelto'));
        const data = migrateTrack(JSON.parse(await file.text()));
        validateTrackData(data);
        data.id = TrackStore.newId();
        resolve(data);
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}
