/**
 * Disegno 2D dell'editor su Canvas: griglia, immagine di sfondo, pista con
 * cordoli, partenza, griglia di partenza, settori, corsia box, oggetti,
 * punti di controllo e maniglie, avvisi.
 */
import { resolveHandles } from '../track/BezierPath';
import { PROP_CATALOG } from '../track/props';
import type { TrackData } from '../track/TrackData';
import { KERB_WIDTH, type TrackSpline } from '../track/TrackSpline';
import type { TrackIssue } from '../track/TrackValidation';
import type { EditorView } from './EditorView';

export type Selection =
  | { kind: 'point'; i: number }
  | { kind: 'hin'; i: number }
  | { kind: 'hout'; i: number }
  | { kind: 'pit'; i: number }
  | { kind: 'prop'; i: number }
  | null;

export interface DrawState {
  data: TrackData;
  spline: TrackSpline | null;
  issues: TrackIssue[];
  selection: Selection;
  hover: Selection;
  tool: string;
  bg: { img: HTMLImageElement; scale: number; x: number; z: number; opacity: number } | null;
  /** punti di calibrazione dello sfondo già cliccati */
  calib: { x: number; z: number }[];
  mouse: { x: number; z: number } | null;
}

export const POINT_R = 7;
export const HANDLE_R = 5;

export function drawEditor(ctx: CanvasRenderingContext2D, v: EditorView, st: DrawState): void {
  const W = v.width, H = v.height;
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  ctx.fillStyle = '#1f2b22';
  ctx.fillRect(0, 0, W, H);

  drawBackground(ctx, v, st);
  drawGrid(ctx, v);
  if (st.spline) {
    drawPit(ctx, v, st);
    drawTrack(ctx, v, st.spline);
    drawMarkers(ctx, v, st.spline);
  }
  drawProps(ctx, v, st);
  drawControlPoints(ctx, v, st);
  drawIssues(ctx, v, st.issues);
  drawCalibration(ctx, v, st);
  drawScaleBar(ctx, v);
}

function drawBackground(ctx: CanvasRenderingContext2D, v: EditorView, st: DrawState) {
  if (!st.bg) return;
  const b = st.bg;
  const [x, y] = v.toScreen(b.x, b.z);
  ctx.globalAlpha = b.opacity;
  ctx.drawImage(b.img, x, y, b.img.width * b.scale * v.zoom, b.img.height * b.scale * v.zoom);
  ctx.globalAlpha = 1;
}

function drawGrid(ctx: CanvasRenderingContext2D, v: EditorView) {
  const steps: [number, string][] = [[10, 'rgba(255,255,255,0.04)'], [100, 'rgba(255,255,255,0.10)']];
  for (const [step, color] of steps) {
    if (step * v.zoom < 8) continue; // troppo fitta: non disegnare
    const tl = v.toWorld(0, 0), br = v.toWorld(v.width, v.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) {
      const [sx] = v.toScreen(x, 0);
      ctx.moveTo(Math.round(sx) + 0.5, 0);
      ctx.lineTo(Math.round(sx) + 0.5, v.height);
    }
    for (let z = Math.floor(tl.z / step) * step; z <= br.z; z += step) {
      const [, sy] = v.toScreen(0, z);
      ctx.moveTo(0, Math.round(sy) + 0.5);
      ctx.lineTo(v.width, Math.round(sy) + 0.5);
    }
    ctx.stroke();
  }
}

function drawTrack(ctx: CanvasRenderingContext2D, v: EditorView, sp: TrackSpline) {
  const smp = sp.samples;
  const edge = (side: 1 | -1, extra = 0) =>
    smp.map((s) => v.toScreen(s.x + s.nx * side * (s.width / 2 + extra), s.z + s.nz * side * (s.width / 2 + extra)));

  // Asfalto: anello tra bordo sinistro e destro (regola evenodd)
  const L = edge(1), R = edge(-1);
  ctx.fillStyle = '#4a4d52';
  ctx.beginPath();
  L.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  R.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill('evenodd');

  // Cordoli a strisce
  const n = smp.length;
  for (let i = 0; i < n; i++) {
    const a = smp[i], b = smp[(i + 1) % n];
    for (const side of [1, -1] as const) {
      if (side === 1 ? !a.kerbLeft : !a.kerbRight) continue;
      ctx.fillStyle = Math.floor(a.s / 3) % 2 ? '#eeeeee' : '#d0302a';
      const q = [
        [a, a.width / 2], [a, a.width / 2 + KERB_WIDTH], [b, b.width / 2 + KERB_WIDTH], [b, b.width / 2],
      ] as const;
      ctx.beginPath();
      q.forEach(([s, d], k) => {
        const [x, y] = v.toScreen(s.x + s.nx * side * d, s.z + s.nz * side * d);
        if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.fill();
    }
  }

  // Bordi e linea centrale
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1;
  for (const e of [L, R]) {
    ctx.beginPath();
    e.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  smp.forEach((s, i) => {
    const [x, y] = v.toScreen(s.x, s.z);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // Frecce del senso di marcia ogni ~120 m
  const every = Math.max(1, Math.round(120 / (sp.length / n)));
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  for (let i = every / 2; i < n; i += every) {
    const s = smp[Math.floor(i)];
    const [x, y] = v.toScreen(s.x, s.z);
    const a = Math.atan2(s.tz, s.tx);
    const k = Math.max(5, Math.min(12, s.width * v.zoom * 0.3));
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * k, y + Math.sin(a) * k);
    ctx.lineTo(x + Math.cos(a + 2.5) * k, y + Math.sin(a + 2.5) * k);
    ctx.lineTo(x + Math.cos(a - 2.5) * k, y + Math.sin(a - 2.5) * k);
    ctx.fill();
  }
}

/** Linea trasversale alla pista nel campione s, con etichetta. */
function crossLine(ctx: CanvasRenderingContext2D, v: EditorView, sp: TrackSpline, s: number, color: string, label: string, w = 3) {
  const p = sp.atS(s);
  const h = p.width / 2 + 2;
  const [x1, y1] = v.toScreen(p.x + p.nx * h, p.z + p.nz * h);
  const [x2, y2] = v.toScreen(p.x - p.nx * h, p.z - p.nz * h);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = 'bold 12px Segoe UI, sans-serif';
  ctx.fillText(label, x1 + 4, y1 - 4);
}

function drawMarkers(ctx: CanvasRenderingContext2D, v: EditorView, sp: TrackSpline) {
  // Griglia di partenza
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (const g of sp.grid) {
    const [x, y] = v.toScreen(g.x, g.z);
    const a = Math.atan2(Math.cos(g.heading), Math.sin(g.heading));
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.fillRect(-2.2 * v.zoom, -1 * v.zoom, 4.4 * v.zoom, 2 * v.zoom);
    ctx.restore();
  }
  sp.sectorS.forEach((s, i) => crossLine(ctx, v, sp, s, '#ffcc00', `S${i + 1}→S${i + 2}`));
  crossLine(ctx, v, sp, 0, '#ffffff', 'PARTENZA', 4);
}

function drawPit(ctx: CanvasRenderingContext2D, v: EditorView, st: DrawState) {
  const pl = st.data.pitLane;
  const sp = st.spline;
  if (!pl) return;
  if (sp?.pit) {
    const pit = sp.pit;
    const hw = pl.width / 2;
    ctx.strokeStyle = '#5c6066';
    ctx.lineWidth = Math.max(2, pl.width * v.zoom);
    ctx.lineCap = 'round';
    ctx.beginPath();
    pit.samples.forEach((s, i) => {
      const [x, y] = v.toScreen(s.x, s.z);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.lineCap = 'butt';
    // linee del limitatore
    for (const s of [pit.limiterStart, pit.limiterEnd]) {
      const p = pit.atS(s);
      const [x1, y1] = v.toScreen(p.x + p.nx * hw, p.z + p.nz * hw);
      const [x2, y2] = v.toScreen(p.x - p.nx * hw, p.z - p.nz * hw);
      ctx.strokeStyle = '#4aa3ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(74,163,255,0.9)';
    ctx.font = '11px Segoe UI, sans-serif';
    const ps = pit.atS(pit.limiterStart);
    const [lx, ly] = v.toScreen(ps.x, ps.z);
    ctx.fillText(`${pl.speedLimitKmh} km/h`, lx + 6, ly - 6);
    // box
    for (const g of pit.garages) {
      const [x, y] = v.toScreen(g.x, g.z);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(Math.cos(g.heading), Math.sin(g.heading)));
      ctx.fillStyle = '#7c8794';
      ctx.fillRect(-5 * v.zoom, -4 * v.zoom, 10 * v.zoom, 8 * v.zoom);
      ctx.restore();
    }
  }
}

function drawProps(ctx: CanvasRenderingContext2D, v: EditorView, st: DrawState) {
  st.data.props.forEach((p, i) => {
    const info = PROP_CATALOG[p.type];
    const [x, y] = v.toScreen(p.x, p.z);
    const len = p.size * v.zoom, dep = Math.max(3, info.depth(p.size) * v.zoom);
    const sel = st.selection?.kind === 'prop' && st.selection.i === i;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((-p.rot * Math.PI) / 180);
    ctx.fillStyle = info.color;
    if (p.type === 'albero') {
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(3, len / 2), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(-len / 2, -dep / 2, len, dep);
      // tacca sul lato "frontale" (verso +Z locale ruotato) per capire l'orientamento
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(-len / 2, dep / 2 - Math.max(1, dep * 0.15), len, Math.max(1, dep * 0.15));
    }
    if (sel) {
      ctx.strokeStyle = '#ffcc00';
      ctx.lineWidth = 2;
      ctx.strokeRect(-len / 2 - 3, -dep / 2 - 3, len + 6, dep + 6);
    }
    ctx.restore();
  });
}

function drawControlPoints(ctx: CanvasRenderingContext2D, v: EditorView, st: DrawState) {
  const pts = st.data.points;
  const handles = resolveHandles(pts, true);
  const sel = st.selection;
  const selIdx = sel && (sel.kind === 'point' || sel.kind === 'hin' || sel.kind === 'hout') ? sel.i : -1;

  // maniglie del punto selezionato
  if (selIdx >= 0) {
    const p = pts[selIdx], h = handles[selIdx];
    const [px, py] = v.toScreen(p.x, p.z);
    for (const [key, hh] of [['hin', h.hin], ['hout', h.hout]] as const) {
      const [hx, hy] = v.toScreen(p.x + hh.x, p.z + hh.z);
      ctx.strokeStyle = 'rgba(120,190,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      const active = sel?.kind === key;
      ctx.fillStyle = active ? '#ffcc00' : '#78beff';
      ctx.fillRect(hx - HANDLE_R, hy - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2);
    }
  }

  const pointsVisible = st.tool === 'select' || st.tool === 'add';
  pts.forEach((p, i) => {
    const [x, y] = v.toScreen(p.x, p.z);
    const isSel = i === selIdx;
    const isHover = st.hover?.kind === 'point' && st.hover.i === i;
    ctx.globalAlpha = pointsVisible ? 1 : 0.35;
    ctx.beginPath();
    ctx.arc(x, y, POINT_R + (isHover ? 2 : 0), 0, Math.PI * 2);
    ctx.fillStyle = isSel ? '#ffcc00' : p.handle === 'corner' ? '#ff9f43' : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#eee';
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.fillText(String(i + 1), x + 9, y - 8);
    ctx.globalAlpha = 1;
  });

  // punti della corsia box
  const pl = st.data.pitLane;
  if (pl) {
    pl.points.forEach((p, i) => {
      const [x, y] = v.toScreen(p.x, p.z);
      const isSel = sel?.kind === 'pit' && sel.i === i;
      ctx.globalAlpha = st.tool === 'pit' ? 1 : 0.35;
      ctx.beginPath();
      ctx.arc(x, y, POINT_R - 1, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? '#ffcc00' : '#4aa3ff';
      ctx.fill();
      ctx.strokeStyle = '#111';
      ctx.stroke();
      ctx.fillStyle = '#9cd0ff';
      ctx.font = '11px Segoe UI, sans-serif';
      ctx.fillText(i === 0 ? 'ingresso box' : i === pl.points.length - 1 ? 'uscita box' : '', x + 9, y - 8);
      ctx.globalAlpha = 1;
    });
  }
}

function drawIssues(ctx: CanvasRenderingContext2D, v: EditorView, issues: TrackIssue[]) {
  for (const is of issues) {
    const [x, y] = v.toScreen(is.x, is.z);
    ctx.strokeStyle = is.level === 'errore' ? '#ff4d4d' : '#ffcc00';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = 'bold 16px Segoe UI, sans-serif';
    ctx.fillText('!', x - 3, y + 6);
  }
}

function drawCalibration(ctx: CanvasRenderingContext2D, v: EditorView, st: DrawState) {
  if (!st.calib.length) return;
  ctx.strokeStyle = '#ff4dd2';
  ctx.fillStyle = '#ff4dd2';
  ctx.lineWidth = 2;
  const pts = [...st.calib, ...(st.mouse && st.calib.length === 1 ? [st.mouse] : [])];
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = v.toScreen(p.x, p.z);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.stroke();
  for (const p of st.calib) {
    const [x, y] = v.toScreen(p.x, p.z);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawScaleBar(ctx: CanvasRenderingContext2D, v: EditorView) {
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const m = nice.find((n) => n * v.zoom >= 80) ?? 1000;
  const px = m * v.zoom;
  const x = 16, y = v.height - 20;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.lineTo(x + px, y - 5);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '12px Segoe UI, sans-serif';
  ctx.fillText(`${m} m`, x + px / 2 - 12, y - 8);
}
