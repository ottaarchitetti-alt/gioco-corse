/**
 * Piloti bot: nomi (inventati), colori delle livree e abilità individuale.
 * Ogni bot ha una piccola variazione rispetto al livello scelto, così non
 * vanno tutti allo stesso passo.
 */
import { DIFFICULTIES, type BotSkill, type Difficulty } from './BotDriver';

const NAMES = [
  'M. Ferri', 'L. Conti', 'A. Greco', 'S. Marino', 'D. Galli', 'F. Riva', 'G. Testa', 'P. Fabbri',
  'E. Moretti', 'C. Barbieri', 'N. Lombardi', 'V. Colombo', 'T. Gentile', 'R. Fontana', 'I. Caruso',
  'O. Serra', 'B. Villa', 'U. Pellegrini', 'K. Sartori', 'H. Neri',
];

const COLORS = [
  '#1f5fbf', '#f2c230', '#2e9e4a', '#ffffff', '#111111', '#e07020', '#8e44ad', '#16a6b6',
  '#c0392b', '#7f8c8d', '#d35490', '#2c3e50', '#a3c639', '#b8860b', '#5dade2', '#6d4c41',
  '#ff8fa3', '#00897b', '#3949ab', '#9e9d24',
];

export interface BotProfile {
  id: string;
  name: string;
  color: string;
  skill: BotSkill;
}

/** Crea `count` bot del livello scelto (stesso risultato a parità di seed). */
export function makeRoster(count: number, difficulty: Difficulty, seed = 1): BotProfile[] {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const base = DIFFICULTIES[difficulty];
  const order = NAMES.map((_, i) => i).sort(() => rnd() - 0.5);
  return Array.from({ length: Math.min(count, NAMES.length) }, (_, k) => {
    const spread = (rnd() - 0.5) * 0.035; // ±1,75% di aderenza tra un bot e l'altro
    return {
      id: `bot_${order[k]}`,
      name: NAMES[order[k]],
      color: COLORS[order[k] % COLORS.length],
      skill: {
        grip: Math.min(0.995, base.grip + spread),
        brake: Math.min(0.98, base.brake + spread * 0.8),
        inconsistency: base.inconsistency,
        errorRate: base.errorRate * (0.7 + rnd() * 0.6),
        aggression: Math.min(1, Math.max(0, base.aggression + (rnd() - 0.5) * 0.3)),
      },
    };
  });
}
