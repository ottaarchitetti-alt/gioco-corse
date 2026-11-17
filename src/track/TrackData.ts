/**
 * Formato JSON di una pista — VERSIONE 2.
 *
 * È il "contratto" tra editor, generatore 3D, cronometraggio e (dalla Fase 5) bot.
 * Le piste salvate nella versione 1 vengono convertite automaticamente (migrateTrack).
 *
 * Il tracciato è una curva di Bézier CHIUSA che passa per `points`, percorsa
 * nell'ordine dei punti. Ogni punto può avere due maniglie (come in Illustrator
 * o Inkscape) che decidono la forma della curva:
 *   - handle "auto":   maniglie calcolate per una curva morbida (default)
 *   - handle "smooth": maniglie dell'utente, allineate (niente spigoli)
 *   - handle "corner": maniglie indipendenti (si possono fare spigoli)
 *
 * Coordinate in METRI sul piano XZ del mondo 3D. Vista dall'alto: X verso destra,
 * Z verso il basso dello schermo (così editor e guida non sono mai specchiati).
 */

export type HandleMode = 'auto' | 'smooth' | 'corner';
/** Cordoli del tratto che parte da questo punto e arriva al successivo. */
export type KerbMode = 'auto' | 'none' | 'left' | 'right' | 'both';

export interface Vec2 {
  x: number;
  z: number;
}

export interface TrackPoint extends Vec2 {
  /** Larghezza della carreggiata in questo punto (m). Se assente: defaultWidth. */
  width?: number;
  handle?: HandleMode;
  /** Maniglie relative al punto (usate se handle ≠ auto) */
  hin?: Vec2;
  hout?: Vec2;
  kerb?: KerbMode;
}

/** Posizione sul tracciato: tratto (indice del punto di partenza) e frazione 0..1 del tratto. */
export interface TrackRef {
  seg: number;
  t: number;
}

export interface PitLane {
  /** Punti della corsia box, dall'ingresso all'uscita (curva aperta). */
  points: Vec2[];
  width: number;
  speedLimitKmh: number;
  /** Lato della corsia su cui stanno i box (rispetto al senso di marcia nella corsia). */
  garageSide: 'left' | 'right';
  /** Numero di box (ogni box = 2 auto) */
  garages: number;
}

export type PropType = 'tribuna' | 'barriera' | 'muro' | 'gomme' | 'albero' | 'edificio' | 'cartellone' | 'modello';

/** Oggetto di contorno. Per "modello" si usa un GLB fatto in Blender (public/models/props). */
export interface PropItem {
  type: PropType;
  x: number;
  z: number;
  /** Rotazione attorno alla verticale (gradi) */
  rot: number;
  /** Lunghezza/scala (m): per tribune, barriere e muri è la lunghezza */
  size: number;
  model?: string;
}

export interface TrackData {
  formatVersion: 2;
  id: string;
  name: string;
  author?: string;
  defaultWidth: number;
  points: TrackPoint[];
  start: TrackRef;
  /** Separatori dei settori (di solito 2 → 3 settori) */
  sectors: TrackRef[];
  pitLane?: PitLane;
  props: PropItem[];
  /** Alberi generati automaticamente attorno alla pista */
  autoTrees: boolean;
  /** Posti in griglia di partenza */
  gridSlots: number;
}

/** Il vecchio formato (Fase 1-2). */
interface TrackDataV1 {
  formatVersion: 1;
  id: string;
  name: string;
  defaultWidth: number;
  points: { x: number; z: number; width?: number }[];
  kerbs: 'auto' | 'none';
}

/** Converte qualsiasi versione nota nel formato corrente. */
export function migrateTrack(raw: unknown): TrackData {
  const t = raw as { formatVersion?: number };
  if (t.formatVersion === 2) {
    const d = raw as TrackData;
    // campi aggiunti in seguito: valori di default
    d.sectors ??= [];
    d.props ??= [];
    d.autoTrees ??= true;
    d.gridSlots ??= 20;
    d.start ??= { seg: 0, t: 0 };
    return d;
  }
  if (t.formatVersion === 1) {
    const v1 = raw as TrackDataV1;
    const n = v1.points.length;
    return {
      formatVersion: 2,
      id: v1.id,
      name: v1.name,
      defaultWidth: v1.defaultWidth,
      points: v1.points.map((p) => ({ ...p, handle: 'auto', kerb: v1.kerbs === 'none' ? 'none' : 'auto' })),
      start: { seg: 0, t: 0 },
      sectors: [{ seg: Math.floor(n / 3), t: 0 }, { seg: Math.floor((2 * n) / 3), t: 0 }],
      props: [],
      autoTrees: true,
      gridSlots: 20,
    };
  }
  throw new Error(`Versione formato pista non supportata: ${t.formatVersion}`);
}

/** Controlli di base sul formato (la validazione geometrica è in TrackValidation). */
export function validateTrackData(t: TrackData): void {
  if (!Array.isArray(t.points) || t.points.length < 3) throw new Error('La pista deve avere almeno 3 punti');
  if (!(t.defaultWidth >= 6)) throw new Error('Larghezza pista non valida (minimo 6 m)');
  for (const p of t.points) {
    if (!isFinite(p.x) || !isFinite(p.z)) throw new Error('Punto con coordinate non valide');
  }
}

/** Pista nuova di partenza per l'editor: un ovale. */
export function newTrack(id: string, name: string): TrackData {
  const pts: TrackPoint[] = [];
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.round(Math.cos(a) * 260), z: Math.round(Math.sin(a) * 160), handle: 'auto', kerb: 'auto' });
  }
  return {
    formatVersion: 2,
    id,
    name,
    defaultWidth: 13,
    points: pts,
    start: { seg: 0, t: 0.2 },
    sectors: [{ seg: 3, t: 0 }, { seg: 6, t: 0 }],
    props: [],
    autoTrees: true,
    gridSlots: 20,
  };
}

/**
 * Impronta della geometria della pista: i record dei tempi sono legati a
 * questa impronta, così se modifichi la pista i vecchi record non valgono più.
 */
export function geometryHash(t: TrackData): string {
  const s = JSON.stringify([t.points, t.defaultWidth, t.start]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
