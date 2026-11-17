/**
 * Piccole funzioni matematiche usate in tutto il progetto.
 */

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Avvicina `current` a `target` di al massimo `maxDelta` (utile per rampe di input). */
export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + sign(d) * maxDelta;
};

/** Interpola un angolo prendendo la strada più breve (radianti). */
export const lerpAngle = (a: number, b: number, t: number): number => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/** Fattore di smorzamento indipendente dal frame rate: 1 - e^(-k·dt). */
export const damp = (k: number, dt: number): number => 1 - Math.exp(-k * dt);

/** Interpolazione lineare in una tabella [[x, y], ...] ordinata per x. */
export const interpTable = (table: [number, number][], x: number): number => {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
};

export const RAD = Math.PI / 180;
export const MS_TO_KMH = 3.6;
export const RPM_TO_RADS = (Math.PI * 2) / 60;

/** Formatta un tempo in secondi come m:ss.mmm */
export const formatLapTime = (t: number | null): string => {
  if (t === null || !isFinite(t)) return '-:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
