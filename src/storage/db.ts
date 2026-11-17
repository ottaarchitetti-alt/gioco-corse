/**
 * Piccolo involucro di IndexedDB (il database del browser: molto più capiente
 * di localStorage, adatto a piste, immagini di sfondo e in futuro assetti e replay).
 *
 * I dati restano SOLO in questo browser su questo PC: per spostarli o
 * condividerli usa "Esporta" (file .json).
 */

const DB_NAME = 'simulatore-corsa';
const DB_VERSION = 2; // 2: aggiunto 'records'
export const STORES = ['tracks', 'backgrounds', 'records'] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const dbGet = <T>(store: StoreName, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key));
export const dbPut = (store: StoreName, key: string, value: unknown) => run<IDBValidKey>(store, 'readwrite', (s) => s.put(value, key));
export const dbDelete = (store: StoreName, key: string) => run<undefined>(store, 'readwrite', (s) => s.delete(key));
export const dbAll = <T>(store: StoreName) => run<T[]>(store, 'readonly', (s) => s.getAll());
