/**
 * FLASHBACK: torna indietro di qualche secondo e rifai la curva.
 *
 * Ogni 0,2 s si salva una "fotografia" completa dello stato dell'auto del pilota (posizione,
 * velocità, gomme, motore, sospensioni, batteria, carburante) e del suo cronometraggio.
 * Le fotografie degli ultimi 20 s stanno in un buffer circolare.
 *
 * La fotografia è una copia generica e profonda degli oggetti: numeri, booleani, stringhe e
 * array vengono copiati; gli oggetti di configurazione (parametri dell'auto, mescola,
 * superfici, funzioni) restano gli stessi riferimenti.
 */

/** Campi che puntano a dati di configurazione condivisi: si salvano per riferimento */
const REF_KEYS = new Set(['car', 'params', 'compound', 'surfaces', 'groundQuery', 'wheelPos', 'onEvent', 'callback']);

type Snap = { [k: string]: unknown };

function isPlainData(v: unknown): boolean {
  return v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'undefined';
}

/** Copia profonda dello stato di un oggetto (solo i dati, non le funzioni). */
export function snapshot(o: object, depth = 0): Snap {
  const out: Snap = {};
  for (const k of Object.keys(o)) {
    const v = (o as Snap)[k];
    if (typeof v === 'function') continue;
    if (REF_KEYS.has(k) || isPlainData(v)) out[k] = v;
    else out[k] = copyValue(v, depth + 1);
  }
  return out;
}

function copyValue(v: unknown, depth: number): unknown {
  if (isPlainData(v) || depth > 6) return v;
  if (ArrayBuffer.isView(v)) return (v as unknown as Float32Array).slice();
  if (Array.isArray(v)) return v.map((x) => copyValue(x, depth + 1));
  if (v instanceof Set || v instanceof Map) return v; // non usati nello stato fisico
  return snapshot(v as object, depth);
}

/** Rimette lo stato salvato dentro l'oggetto (mantenendo gli stessi oggetti e array). */
export function restore(o: object, s: Snap): void {
  const target = o as Snap;
  for (const k of Object.keys(s)) {
    const sv = s[k];
    const cur = target[k];
    if (REF_KEYS.has(k) || isPlainData(sv)) {
      target[k] = sv;
    } else if (ArrayBuffer.isView(sv)) {
      if (ArrayBuffer.isView(cur) && (cur as unknown as Float32Array).length === (sv as unknown as Float32Array).length) (cur as unknown as Float32Array).set(sv as unknown as Float32Array);
      else target[k] = (sv as unknown as Float32Array).slice();
    } else if (Array.isArray(sv)) {
      const arr = Array.isArray(cur) ? cur : (target[k] = []);
      arr.length = sv.length;
      for (let i = 0; i < sv.length; i++) {
        const x = sv[i];
        if (isPlainData(x)) arr[i] = x;
        else if (arr[i] && typeof arr[i] === 'object' && !Array.isArray(x)) restore(arr[i] as object, x as Snap);
        else arr[i] = copyValue(x, 0);
      }
    } else if (sv instanceof Set || sv instanceof Map) {
      target[k] = sv;
    } else if (cur && typeof cur === 'object') {
      restore(cur, sv as Snap);
    } else {
      target[k] = copyValue(sv, 0);
    }
  }
}

export interface FlashbackFrame {
  /** secondi di sessione (per il messaggio "−3 s") */
  time: number;
  state: Snap;
}

/** Buffer circolare delle fotografie. */
export class FlashbackBuffer {
  static readonly INTERVAL = 0.2;
  static readonly SECONDS = 20;
  private frames: FlashbackFrame[] = [];
  private acc = 0;

  /** Chiamato a ogni passo fisico: ogni 0,2 s salva una fotografia. */
  record(dt: number, time: number, take: () => Snap): void {
    this.acc += dt;
    if (this.acc < FlashbackBuffer.INTERVAL) return;
    this.acc = 0;
    this.frames.push({ time, state: take() });
    const max = Math.round(FlashbackBuffer.SECONDS / FlashbackBuffer.INTERVAL);
    if (this.frames.length > max) this.frames.shift();
  }

  /** Fotografia di circa `secondsBack` secondi prima di `now` (la più vecchia se non ce n'è). */
  find(now: number, secondsBack: number): { frame: FlashbackFrame; index: number } | null {
    if (!this.frames.length) return null;
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (now - this.frames[i].time >= secondsBack - 1e-6) return { frame: this.frames[i], index: i };
    }
    return { frame: this.frames[0], index: 0 };
  }

  get oldestAge(): number {
    return this.frames.length ? this.frames[this.frames.length - 1].time - this.frames[0].time : 0;
  }

  /** Dopo il flashback si riparte da lì: le fotografie più recenti non valgono più. */
  truncate(index: number): void {
    this.frames.length = index + 1;
    this.acc = 0;
  }

  clear(): void {
    this.frames = [];
    this.acc = 0;
  }
}
