/**
 * Record personali: miglior giro per (pista + geometria + auto), con i settori,
 * la traccia per il delta e il "fantasma" (traiettoria) per allenarsi.
 * Salvati in IndexedDB: restano tra una sessione e l'altra.
 */
import { dbGet, dbPut } from './db';

export interface LapRecordData {
  lapTime: number;
  /** settori del giro record */
  sectors: number[];
  /** miglior tempo MAI fatto in ogni settore (anche in giri diversi): per il colore viola */
  bestSectors: (number | null)[];
  /** tempo ogni 10 m (per il delta in tempo reale) */
  trace: number[];
  /** fantasma: terne x, z, imbardata campionate a GHOST_RATE Hz */
  ghost: number[];
  date: number;
  compound: string;
}

export const RecordStore = {
  key: (trackKey: string, carId: string) => `${trackKey}|${carId}`,
  load: (key: string) => dbGet<LapRecordData>('records', key),
  save: (key: string, r: LapRecordData) => dbPut('records', key, r),
};
