/**
 * METEO della sessione.
 *
 *   asciutto  → niente pioggia
 *   variabile → uno o due scrosci in momenti casuali (si vedono arrivare nelle previsioni)
 *   pioggia   → si parte sul bagnato, piove quasi sempre (a volte smette verso la fine)
 *
 * Due grandezze:
 *   rain     = quanto piove adesso (0..1)
 *   wetness  = quanto è bagnata la pista (0..1): sale con la pioggia (forte: ~40 s per
 *              bagnarla del tutto), scende quando smette (~6–7 minuti per asciugarsi).
 *
 * GOMME: le slick perdono aderenza molto in fretta sul bagnato; le intermedie vanno meglio
 * con poca acqua; quelle da bagnato con tanta. Sull'asciutto le gomme da pioggia si
 * surriscaldano e si consumano (vedi Tire.ts). Curve di aderenza nel file dell'auto (wetGrip).
 */
import type { Compound } from '../physics/CarParams';
import { wetGripFactor } from '../physics/Tire';

export { wetGripFactor };

export type WeatherMode = 'asciutto' | 'variabile' | 'pioggia';
export const WEATHER_NAMES: Record<WeatherMode, string> = { asciutto: '☀ Asciutto', variabile: '⛅ Variabile', pioggia: '🌧 Pioggia' };

/** Uno scroscio: inizio e fine (s di sessione) e intensità massima */
interface Shower {
  t0: number;
  t1: number;
  peak: number;
}

/** Che gomma serve con questa pista: con isteresi rispetto a quella montata */
export function idealTyreClass(w: number, current: 'slick' | 'intermedia' | 'bagnato'): 'slick' | 'intermedia' | 'bagnato' {
  if (current === 'slick') return w > 0.7 ? 'bagnato' : w > 0.2 ? 'intermedia' : 'slick';
  if (current === 'intermedia') return w > 0.72 ? 'bagnato' : w < 0.1 ? 'slick' : 'intermedia';
  return w < 0.08 ? 'slick' : w < 0.55 ? 'intermedia' : 'bagnato';
}

export function tyreClassOf(c: Compound): 'slick' | 'intermedia' | 'bagnato' {
  if (!c.wet) return 'slick';
  return /bagnat|wet/i.test(c.name) ? 'bagnato' : 'intermedia';
}

export class Weather {
  rain = 0;
  wetness = 0;
  /** tempo di sessione (s) */
  time = 0;
  private showers: Shower[] = [];

  constructor(readonly mode: WeatherMode, durationS: number, rnd: () => number = Math.random) {
    const D = Math.max(300, durationS);
    if (mode === 'variabile') {
      const n = rnd() < 0.55 ? 1 : 2;
      let t = D * (0.12 + rnd() * 0.35);
      for (let i = 0; i < n && t < D * 0.85; i++) {
        const len = Math.max(120, D * (0.18 + rnd() * 0.3));
        this.showers.push({ t0: t, t1: t + len, peak: 0.3 + rnd() * 0.6 });
        t += len + D * (0.15 + rnd() * 0.2);
      }
    } else if (mode === 'pioggia') {
      const stops = rnd() < 0.4;
      this.showers.push({ t0: -60, t1: stops ? D * (0.6 + rnd() * 0.25) : D * 3, peak: 0.55 + rnd() * 0.4 });
      this.wetness = 0.75;
    }
    this.rain = this.rainAt(0);
  }

  /** Intensità della pioggia al tempo t (rampe di ~40 s all'inizio e alla fine di ogni scroscio) */
  rainAt(t: number): number {
    let r = 0;
    for (const s of this.showers) {
      if (t < s.t0 || t > s.t1) continue;
      const ramp = Math.min(1, (t - s.t0) / 40, (s.t1 - t) / 40);
      // piccole variazioni d'intensità dentro lo scroscio
      const wobble = 0.85 + 0.15 * Math.sin(t / 37 + s.t0);
      r = Math.max(r, s.peak * ramp * wobble);
    }
    return r;
  }

  /**
   * @param trackTemp temperatura dell'asfalto asciutto (°C): più caldo = asciuga prima
   */
  update(dt: number, trackTemp: number): void {
    this.time += dt;
    this.rain = this.rainAt(this.time);
    // pioggia forte: ~2 minuti per bagnare del tutto la pista; leggera: molto di più
    const wetUp = this.rain * 0.0045 * (1 + this.rain);
    const dry = this.rain < 0.15 ? 0.0016 * (1 + Math.max(0, trackTemp) / 40) * (1 - this.rain / 0.15) : 0;
    // con pioggia leggera la pista non diventa fradicia: tende a un livello che dipende dalla pioggia
    const cap = Math.min(1, 0.35 + this.rain * 1.1);
    this.wetness = Math.max(0, Math.min(1, this.wetness + (this.wetness < cap ? wetUp : -0.002) * dt - dry * dt));
  }

  /** Prossimo cambiamento: quando inizia o finisce la pioggia (s da adesso, entro `horizon`) */
  forecast(horizon = 900): { kind: 'inizia' | 'smette'; inS: number; peak: number } | null {
    const raining = this.rain > 0.05;
    for (let dt = 15; dt <= horizon; dt += 15) {
      const r = this.rainAt(this.time + dt);
      if (!raining && r > 0.05) {
        let peak = 0;
        for (let k = dt; k < dt + 400; k += 20) peak = Math.max(peak, this.rainAt(this.time + k));
        return { kind: 'inizia', inS: dt, peak };
      }
      if (raining && r <= 0.05) return { kind: 'smette', inS: dt, peak: 0 };
    }
    return null;
  }

  /** Parole per l'intensità della pioggia */
  static rainWord(r: number): string {
    return r < 0.05 ? 'niente pioggia' : r < 0.3 ? 'pioggia leggera' : r < 0.65 ? 'pioggia' : 'pioggia forte';
  }

  static wetWord(w: number): string {
    return w < 0.08 ? 'asciutta' : w < 0.25 ? 'umida' : w < 0.6 ? 'bagnata' : 'fradicia';
  }
}
