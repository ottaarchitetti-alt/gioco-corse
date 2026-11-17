/**
 * Formato JSON di una pista (versione 1).
 *
 * È il "contratto" tra editor (Fase 3), generatore 3D, cronometraggio e bot.
 * In Fase 3 verranno aggiunti: cordoli manuali, corsia box, griglia, settori.
 * Il campo `formatVersion` permette di aggiornare il formato senza rompere
 * le piste già salvate.
 *
 * Il tracciato è una spline chiusa che passa per `points`, percorsa
 * nell'ordine dei punti. La linea di partenza è sul primo punto.
 */
export interface TrackPoint {
  x: number; // metri
  z: number; // metri
  /** Larghezza della carreggiata in questo punto (m). Se assente: defaultWidth. */
  width?: number;
}

export interface TrackData {
  formatVersion: 1;
  id: string;
  name: string;
  defaultWidth: number;
  points: TrackPoint[];
  /** Cordoli: per ora "auto" = generati dove la curva è abbastanza stretta. */
  kerbs: 'auto' | 'none';
}

export async function loadTrack(url: string): Promise<TrackData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Impossibile caricare la pista: ${url}`);
  const data = (await res.json()) as TrackData;
  validateTrack(data);
  return data;
}

/** Controlli minimi: in Fase 3 l'editor farà verifiche più complete. */
export function validateTrack(t: TrackData): void {
  if (t.formatVersion !== 1) throw new Error(`Versione formato pista non supportata: ${t.formatVersion}`);
  if (!Array.isArray(t.points) || t.points.length < 4) throw new Error('La pista deve avere almeno 4 punti');
  if (!(t.defaultWidth > 4)) throw new Error('Larghezza pista non valida');
}
