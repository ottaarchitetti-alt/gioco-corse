/**
 * Catalogo degli oggetti di contorno posizionabili nell'editor.
 * `size` è la lunghezza (o il diametro per gli alberi); `depth` dice quanto è profondo.
 * "modello" usa un tuo GLB da Blender (percorso relativo a /public, es. models/props/tribuna.glb).
 */
import type { PropType } from './TrackData';

export interface PropInfo {
  label: string;
  /** colore nell'editor 2D */
  color: string;
  defaultSize: number;
  minSize: number;
  maxSize: number;
  /** profondità (m) in funzione della lunghezza */
  depth: (size: number) => number;
}

export const PROP_CATALOG: Record<PropType, PropInfo> = {
  tribuna: { label: 'Tribuna', color: '#8aa0b8', defaultSize: 60, minSize: 10, maxSize: 300, depth: () => 14 },
  barriera: { label: 'Guardrail', color: '#c9ced6', defaultSize: 50, minSize: 4, maxSize: 400, depth: () => 0.4 },
  muro: { label: 'Muro in cemento', color: '#a9a39a', defaultSize: 50, minSize: 4, maxSize: 400, depth: () => 0.6 },
  gomme: { label: 'Barriera di gomme', color: '#2b2b2b', defaultSize: 30, minSize: 3, maxSize: 200, depth: () => 1.4 },
  albero: { label: 'Albero', color: '#3f7a3a', defaultSize: 7, minSize: 2, maxSize: 20, depth: (s) => s },
  edificio: { label: 'Edificio', color: '#b08a6a', defaultSize: 30, minSize: 6, maxSize: 200, depth: (s) => s * 0.6 },
  cartellone: { label: 'Cartellone', color: '#e0a030', defaultSize: 12, minSize: 3, maxSize: 40, depth: () => 0.4 },
  modello: { label: 'Modello GLB', color: '#c56cf0', defaultSize: 10, minSize: 1, maxSize: 200, depth: (s) => s },
};

export const PROP_TYPES = Object.keys(PROP_CATALOG) as PropType[];
