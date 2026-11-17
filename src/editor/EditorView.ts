/**
 * "Telecamera" 2D dell'editor: conversione mondo (metri) ↔ schermo (pixel),
 * zoom con la rotellina attorno al cursore, spostamento.
 *
 * Vista dall'alto: X mondo → destra, Z mondo → giù. È la stessa orientazione
 * della scena 3D vista dall'alto, quindi la pista non risulta mai specchiata.
 */
import type { Vec2 } from '../track/TrackData';

export class EditorView {
  /** Centro della vista nel mondo (m) */
  cx = 0;
  cz = 0;
  /** pixel per metro */
  zoom = 1;
  width = 1;
  height = 1;
  dpr = 1;

  toScreen(x: number, z: number): [number, number] {
    return [(x - this.cx) * this.zoom + this.width / 2, (z - this.cz) * this.zoom + this.height / 2];
  }

  toWorld(sx: number, sy: number): Vec2 {
    return { x: (sx - this.width / 2) / this.zoom + this.cx, z: (sy - this.height / 2) / this.zoom + this.cz };
  }

  /** Zoom mantenendo fermo il punto sotto il cursore. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.min(40, Math.max(0.05, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cz += before.z - after.z;
  }

  pan(dxPx: number, dyPx: number): void {
    this.cx -= dxPx / this.zoom;
    this.cz -= dyPx / this.zoom;
  }

  /** Inquadra un insieme di punti con un margine. */
  fit(points: Vec2[], margin = 80): void {
    if (!points.length) return;
    const xs = points.map((p) => p.x), zs = points.map((p) => p.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
    this.cx = (minX + maxX) / 2;
    this.cz = (minZ + maxZ) / 2;
    const w = Math.max(50, maxX - minX), h = Math.max(50, maxZ - minZ);
    this.zoom = Math.min((this.width - margin * 2) / w, (this.height - margin * 2) / h);
  }
}
