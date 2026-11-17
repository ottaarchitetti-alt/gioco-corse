/**
 * Controlli geometrici di una pista, mostrati come avvisi nell'editor.
 *
 *  - ERRORE: curva con raggio minore di metà carreggiata → il bordo interno
 *    si "ripiega" su sé stesso e la mesh 3D viene rovinata.
 *  - AVVISO: curva molto stretta (raggio < larghezza): guidabile ma brutta.
 *  - ERRORE: due parti di pista che si toccano o si incrociano (incroci e
 *    ponti non sono supportati: pista piatta, scelta D7).
 */
import type { TrackSpline } from './TrackSpline';

export interface TrackIssue {
  level: 'errore' | 'avviso';
  message: string;
  x: number;
  z: number;
}

export function validateTrack(track: TrackSpline): TrackIssue[] {
  const issues: TrackIssue[] = [];
  const smp = track.samples;
  const n = smp.length;

  // ---- Raggi di curvatura ----
  // raggruppiamo i campioni consecutivi con lo stesso problema per non avere 50 avvisi uguali
  let i = 0;
  while (i < n) {
    const s = smp[i];
    const r = 1 / Math.max(Math.abs(s.curvature), 1e-6);
    const level = r < s.width / 2 + 0.5 ? 'errore' : r < s.width ? 'avviso' : null;
    if (!level) { i++; continue; }
    let j = i, minR = r, at = s;
    while (j + 1 < n) {
      const q = smp[j + 1];
      const rq = 1 / Math.max(Math.abs(q.curvature), 1e-6);
      if (rq >= q.width) break;
      if (rq < minR) { minR = rq; at = q; }
      j++;
    }
    issues.push({
      level: minR < at.width / 2 + 0.5 ? 'errore' : 'avviso',
      message: minR < at.width / 2 + 0.5
        ? `Curva troppo stretta (raggio ${minR.toFixed(0)} m con pista larga ${at.width.toFixed(0)} m)`
        : `Curva molto stretta (raggio ${minR.toFixed(0)} m)`,
      x: at.x, z: at.z,
    });
    i = j + 1;
  }

  // ---- Parti di pista troppo vicine (sovrapposizione o incrocio) ----
  // Confrontiamo campioni lontani lungo la pista ma vicini nello spazio.
  const stepIdx = 3; // ~6 m
  const found: { x: number; z: number }[] = [];
  for (let a = 0; a < n; a += stepIdx) {
    for (let b = a + stepIdx; b < n; b += stepIdx) {
      const alongGap = Math.min(b - a, n - (b - a)) * (track.length / n);
      const pa = smp[a], pb = smp[b];
      const minDist = (pa.width + pb.width) / 2 + 2; // bordo contro bordo, +2 m di margine
      if (alongGap < minDist * 2.5) continue; // stessa zona della pista: normale
      const d = Math.hypot(pa.x - pb.x, pa.z - pb.z);
      if (d < minDist) {
        const x = (pa.x + pb.x) / 2, z = (pa.z + pb.z) / 2;
        if (found.some((f) => Math.hypot(f.x - x, f.z - z) < 40)) continue;
        found.push({ x, z });
        issues.push({ level: 'errore', message: 'Due tratti di pista si toccano o si incrociano', x, z });
      }
    }
  }
  return issues;
}
