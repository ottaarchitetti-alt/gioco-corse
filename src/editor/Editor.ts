/**
 * EDITOR PISTE 2D.
 *
 * Strumenti (barra in alto, o tasti rapidi):
 *   V  Seleziona/Muovi   punti, maniglie; doppio clic sulla pista = nuovo punto
 *   A  Aggiungi punti    clic = nuovo punto nel tratto più vicino
 *   P  Partenza          clic sulla pista = linea di partenza/arrivo
 *   S  Settori           clic = separatore del settore scelto
 *   B  Corsia box        clic = aggiunge un punto (dall'ingresso all'uscita)
 *   O  Oggetti           clic = piazza l'oggetto scelto; trascina per spostarlo
 *   I  Immagine sfondo   per ricalcare un circuito reale
 *
 * Sempre: rotellina = zoom, tasto destro/centrale trascinato = sposta la vista,
 * Canc = elimina selezione, Ctrl+Z / Ctrl+Y = annulla/ripeti, F = inquadra tutto.
 * Il salvataggio è automatico (IndexedDB).
 */
import { TrackStore, downloadTrack, type TrackBackground } from '../storage/TrackStore';
import { PROP_CATALOG } from '../track/props';
import type { PropType, TrackData, Vec2 } from '../track/TrackData';
import { TrackSpline } from '../track/TrackSpline';
import { validateTrack, type TrackIssue } from '../track/TrackValidation';
import { navigate } from '../ui/router';
import { drawEditor, HANDLE_R, POINT_R, type Selection } from './EditorRenderer';
import { EditorPanel } from './EditorPanel';
import { EditorView } from './EditorView';
import { History } from './History';
import { deletePoint, insertPoint, moveHandle, nearestRef, round } from './trackOps';
import { resolveHandles } from '../track/BezierPath';

export type Tool = 'select' | 'add' | 'start' | 'sector' | 'pit' | 'props' | 'background';

export const TOOLS: { id: Tool; label: string; key: string; help: string }[] = [
  { id: 'select', label: 'Seleziona', key: 'V', help: 'Trascina punti e maniglie (Alt = maniglie indipendenti). Doppio clic sulla pista: nuovo punto. Trascina il vuoto per spostare la vista.' },
  { id: 'add', label: 'Aggiungi punti', key: 'A', help: 'Clic: nuovo punto nel tratto di pista più vicino.' },
  { id: 'start', label: 'Partenza', key: 'P', help: 'Clic sulla pista: posiziona la linea di partenza/arrivo. La griglia si forma dietro.' },
  { id: 'sector', label: 'Settori', key: 'S', help: 'Scegli il separatore nel pannello, poi clic sulla pista.' },
  { id: 'pit', label: 'Corsia box', key: 'B', help: 'Clic: aggiunge un punto alla corsia box, dall\'ingresso verso l\'uscita. Parti e arriva sul bordo della pista.' },
  { id: 'props', label: 'Oggetti', key: 'O', help: 'Scegli il tipo nel pannello, clic per piazzarlo. Trascina per spostare, R per ruotare di 15°.' },
  { id: 'background', label: 'Sfondo', key: 'I', help: 'Carica un\'immagine (es. foto satellitare) da ricalcare. Trascinala per spostarla, calibra la scala con due clic.' },
];

interface DragState {
  kind: 'pan' | 'point' | 'hin' | 'hout' | 'pit' | 'prop' | 'bg';
  i: number;
  startScreen: [number, number];
  startWorld: Vec2;
  origin: Vec2;
}

export class Editor {
  data: TrackData;
  spline: TrackSpline | null = null;
  issues: TrackIssue[] = [];
  readonly view = new EditorView();
  readonly history = new History<TrackData>();
  tool: Tool = 'select';
  selection: Selection = null;
  hover: Selection = null;
  /** Tipo di oggetto da piazzare e separatore di settore da posizionare */
  propType: PropType = 'tribuna';
  sectorIndex = 0;
  bg: (TrackBackground & { img: HTMLImageElement }) | null = null;
  calib: Vec2[] = [];
  calibrating = false;
  saveState: 'salvato' | 'modificato' | 'salvataggio…' | 'errore' = 'salvato';

  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private panel!: EditorPanel;
  private drag: DragState | null = null;
  private mouse: Vec2 | null = null;
  private saveTimer = 0;
  private needsDraw = true;

  constructor(parent: HTMLElement, data: TrackData) {
    this.data = data;
    this.root = document.createElement('div');
    this.root.className = 'editor';
    this.root.innerHTML = `<div class="ed-toolbar"></div><div class="ed-main"><div class="ed-canvas-wrap"><canvas></canvas><div class="ed-help"></div></div><div class="ed-panel"></div></div>`;
    parent.appendChild(this.root);
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
  }

  async init(): Promise<void> {
    this.panel = new EditorPanel(this, this.root.querySelector('.ed-toolbar')!, this.root.querySelector('.ed-panel')!);
    try {
      const bg = await TrackStore.loadBackground(this.data.id);
      if (bg) await this.setBackground(bg);
    } catch { /* nessuno sfondo */ }
    this.resize();
    this.view.fit(this.data.points);
    this.rebuild();
    this.bindEvents();
    this.panel.render();
    const loop = () => {
      if (this.needsDraw) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ===================== stato =====================

  /** Ricalcola geometria e avvisi dopo una modifica. */
  rebuild(): void {
    try {
      this.spline = new TrackSpline(this.data);
      this.issues = validateTrack(this.spline);
    } catch (e) {
      this.spline = null;
      this.issues = [{ level: 'errore', message: e instanceof Error ? e.message : String(e), x: 0, z: 0 }];
    }
    this.needsDraw = true;
  }

  /** Esegue una modifica registrandola nella cronologia, poi aggiorna e salva. */
  change(fn: () => void): void {
    this.history.record(this.data);
    fn();
    this.committed();
  }

  /** Dopo una modifica: ricalcola, aggiorna pannello, programma il salvataggio. */
  committed(): void {
    this.rebuild();
    this.panel.render();
    this.scheduleSave();
  }

  undo(): void {
    const prev = this.history.undo(this.data);
    if (prev) { this.data = prev; this.selection = null; this.committed(); }
  }

  redo(): void {
    const next = this.history.redo(this.data);
    if (next) { this.data = next; this.selection = null; this.committed(); }
  }

  scheduleSave(): void {
    this.saveState = 'modificato';
    this.panel.renderStatus();
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 700);
  }

  async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveState = 'salvataggio…';
    this.panel.renderStatus();
    try {
      await TrackStore.save(this.data);
      this.saveState = 'salvato';
    } catch (e) {
      console.error(e);
      this.saveState = 'errore';
    }
    this.panel.renderStatus();
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.calibrating = false;
    this.calib = [];
    if (t !== 'select' && t !== 'add' && (this.selection?.kind === 'point' || this.selection?.kind === 'hin' || this.selection?.kind === 'hout')) this.selection = null;
    this.panel.render();
    this.needsDraw = true;
  }

  select(s: Selection): void {
    this.selection = s;
    this.panel.render();
    this.needsDraw = true;
  }

  deleteSelection(): void {
    const s = this.selection;
    if (!s) return;
    if (s.kind === 'point' || s.kind === 'hin' || s.kind === 'hout') {
      if (this.data.points.length <= 3) return alert('Servono almeno 3 punti.');
      this.change(() => deletePoint(this.data, s.i));
    } else if (s.kind === 'pit') {
      this.change(() => {
        const pl = this.data.pitLane!;
        pl.points.splice(s.i, 1);
        if (pl.points.length === 0) delete this.data.pitLane;
      });
    } else if (s.kind === 'prop') {
      this.change(() => this.data.props.splice(s.i, 1));
    }
    this.select(null);
  }

  async playTrack(): Promise<void> {
    if (this.issues.some((i) => i.level === 'errore') &&
      !confirm('La pista ha degli errori (cerchi rossi). La geometria 3D potrebbe essere rovinata. Provarla lo stesso?')) return;
    await this.save();
    navigate('guida', { pista: this.data.id, da: 'editor' });
  }

  async goMenu(): Promise<void> {
    await this.save();
    navigate('menu');
  }

  exportFile(): void {
    downloadTrack(this.data);
  }

  private previewOpen = false;
  /** Anteprima 3D aperta (se c'è) */
  preview: { close(): void } | null = null;

  async openPreview(): Promise<void> {
    if (!this.spline) return alert('La pista non è valida: correggi gli errori prima dell\'anteprima.');
    if (this.previewOpen) return;
    const { Preview3D } = await import('./Preview3D');
    this.previewOpen = true;
    this.preview = new Preview3D(this.spline, () => { this.previewOpen = false; this.preview = null; });
  }

  centerOn(x: number, z: number): void {
    this.view.cx = x;
    this.view.cz = z;
    this.view.zoom = Math.max(this.view.zoom, 1.5);
    this.needsDraw = true;
  }

  fitView(): void {
    const pts: Vec2[] = [...this.data.points, ...(this.data.pitLane?.points ?? [])];
    this.view.fit(pts);
    this.needsDraw = true;
  }

  // ===================== sfondo =====================

  async setBackground(bg: TrackBackground): Promise<void> {
    const img = new Image();
    img.src = bg.dataUrl;
    await img.decode();
    this.bg = { ...bg, img };
    this.needsDraw = true;
  }

  async loadBackgroundFile(file: File): Promise<void> {
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    // dimensione iniziale: larga quanto la pista (o 1,5 km) e centrata nella vista
    const xs = this.data.points.map((p) => p.x);
    const span = Math.max(500, Math.max(...xs) - Math.min(...xs)) * 1.3;
    const scale = span / img.width;
    await this.setBackground({
      dataUrl, scale, opacity: 0.6,
      x: this.view.cx - (img.width * scale) / 2,
      z: this.view.cz - (img.height * scale) / 2,
    });
    this.saveBackground();
    this.panel.render();
  }

  saveBackground(): void {
    if (!this.bg) return;
    const { img: _img, ...rest } = this.bg;
    void TrackStore.saveBackground(this.data.id, rest);
  }

  removeBackground(): void {
    this.bg = null;
    void TrackStore.removeBackground(this.data.id);
    this.panel.render();
    this.needsDraw = true;
  }

  startCalibration(): void {
    this.calibrating = true;
    this.calib = [];
    this.needsDraw = true;
  }

  // ===================== input =====================

  private bindEvents(): void {
    const c = this.canvas;
    new ResizeObserver(() => this.resize()).observe(c.parentElement!);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', () => this.onUp());
    c.addEventListener('dblclick', (e) => this.onDouble(e));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = this.screenPos(e);
      this.view.zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
      this.needsDraw = true;
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private screenPos(e: MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private resize(): void {
    const wrap = this.canvas.parentElement!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.view.width = wrap.clientWidth;
    this.view.height = wrap.clientHeight;
    this.view.dpr = dpr;
    this.canvas.width = Math.round(wrap.clientWidth * dpr);
    this.canvas.height = Math.round(wrap.clientHeight * dpr);
    this.canvas.style.width = wrap.clientWidth + 'px';
    this.canvas.style.height = wrap.clientHeight + 'px';
    this.needsDraw = true;
  }

  /** Cosa c'è sotto il cursore (in pixel), secondo lo strumento attivo. */
  private hitTest(sx: number, sy: number): Selection {
    const v = this.view;
    const near = (x: number, z: number, r: number) => {
      const [px, py] = v.toScreen(x, z);
      return Math.hypot(px - sx, py - sy) <= r + 3;
    };
    const t = this.tool;
    if (t === 'select' || t === 'add') {
      const s = this.selection;
      if (s && (s.kind === 'point' || s.kind === 'hin' || s.kind === 'hout')) {
        const p = this.data.points[s.i];
        const h = resolveHandles(this.data.points, true)[s.i];
        if (near(p.x + h.hout.x, p.z + h.hout.z, HANDLE_R)) return { kind: 'hout', i: s.i };
        if (near(p.x + h.hin.x, p.z + h.hin.z, HANDLE_R)) return { kind: 'hin', i: s.i };
      }
      for (let i = this.data.points.length - 1; i >= 0; i--) {
        const p = this.data.points[i];
        if (near(p.x, p.z, POINT_R)) return { kind: 'point', i };
      }
    }
    if (t === 'pit' && this.data.pitLane) {
      const pts = this.data.pitLane.points;
      for (let i = pts.length - 1; i >= 0; i--) if (near(pts[i].x, pts[i].z, POINT_R)) return { kind: 'pit', i };
    }
    if (t === 'props') {
      const w = v.toWorld(sx, sy);
      for (let i = this.data.props.length - 1; i >= 0; i--) {
        const p = this.data.props[i];
        const info = PROP_CATALOG[p.type];
        // nel riferimento dell'oggetto (ruotato)
        const r = (p.rot * Math.PI) / 180;
        const dx = w.x - p.x, dz = w.z - p.z;
        const lx = dx * Math.cos(r) - dz * Math.sin(r);
        const lz = dx * Math.sin(r) + dz * Math.cos(r);
        const tol = 4 / v.zoom;
        if (Math.abs(lx) <= p.size / 2 + tol && Math.abs(lz) <= info.depth(p.size) / 2 + tol) return { kind: 'prop', i };
      }
    }
    return null;
  }

  private onDown(e: MouseEvent): void {
    const [sx, sy] = this.screenPos(e);
    const w = this.view.toWorld(sx, sy);
    const startDrag = (kind: DragState['kind'], i: number, origin: Vec2) => {
      this.drag = { kind, i, startScreen: [sx, sy], startWorld: w, origin: { ...origin } };
    };
    if (e.button === 1 || e.button === 2) return startDrag('pan', -1, w);
    if (e.button !== 0) return;

    // Calibrazione dello sfondo: due clic, poi la distanza reale
    if (this.calibrating) {
      this.calib.push(w);
      if (this.calib.length === 2) this.finishCalibration();
      this.needsDraw = true;
      return;
    }

    const hit = this.hitTest(sx, sy);
    const tool = this.tool;

    if (hit) {
      this.history.record(this.data);
      this.select(hit);
      if (hit.kind === 'point') startDrag('point', hit.i, this.data.points[hit.i]);
      else if (hit.kind === 'hin' || hit.kind === 'hout') {
        const p = this.data.points[hit.i];
        startDrag(hit.kind, hit.i, p);
      } else if (hit.kind === 'pit') startDrag('pit', hit.i, this.data.pitLane!.points[hit.i]);
      else if (hit.kind === 'prop') startDrag('prop', hit.i, this.data.props[hit.i]);
      return;
    }

    switch (tool) {
      case 'select':
        this.select(null);
        return startDrag('pan', -1, w);
      case 'add': {
        const ref = nearestRef(this.data, w);
        this.history.record(this.data);
        const idx = insertPoint(this.data, ref.seg, ref.t);
        // il nuovo punto va dove ho cliccato (non sulla curva)
        this.data.points[idx].x = round(w.x);
        this.data.points[idx].z = round(w.z);
        this.committed();
        this.select({ kind: 'point', i: idx });
        return startDrag('point', idx, this.data.points[idx]);
      }
      case 'start':
      case 'sector': {
        const ref = nearestRef(this.data, w);
        if (ref.dist > 60) return;
        this.change(() => {
          const r = { seg: ref.seg, t: round(ref.t, 1000) };
          if (tool === 'start') this.data.start = r;
          else {
            while (this.data.sectors.length <= this.sectorIndex) this.data.sectors.push({ ...r });
            this.data.sectors[this.sectorIndex] = r;
          }
        });
        return;
      }
      case 'pit': {
        this.history.record(this.data);
        if (!this.data.pitLane) {
          this.data.pitLane = { points: [], width: 11, speedLimitKmh: 60, garageSide: 'right', garages: 10 };
        }
        const pts = this.data.pitLane.points;
        pts.push({ x: round(w.x), z: round(w.z) });
        this.committed();
        this.select({ kind: 'pit', i: pts.length - 1 });
        return startDrag('pit', pts.length - 1, pts[pts.length - 1]);
      }
      case 'props': {
        this.history.record(this.data);
        const info = PROP_CATALOG[this.propType];
        // orientamento iniziale: lungo la pista, con il lato frontale (+Z locale) rivolto verso di essa
        let rot = 0;
        if (this.spline) {
          const p = this.spline.project(w.x, w.z);
          const vx = p.sample.x - w.x, vz = p.sample.z - w.z;
          rot = Math.round((Math.atan2(vx, vz) * 180) / Math.PI);
          rot = ((rot % 360) + 360) % 360;
        }
        this.data.props.push({ type: this.propType, x: round(w.x), z: round(w.z), rot, size: info.defaultSize });
        this.committed();
        const i = this.data.props.length - 1;
        this.select({ kind: 'prop', i });
        return startDrag('prop', i, this.data.props[i]);
      }
      case 'background':
        if (this.bg) return startDrag('bg', -1, { x: this.bg.x, z: this.bg.z });
        return startDrag('pan', -1, w);
    }
  }

  private onMove(e: MouseEvent): void {
    const [sx, sy] = this.screenPos(e);
    const w = this.view.toWorld(sx, sy);
    this.mouse = w;
    this.panel.renderCursor(w);
    const d = this.drag;
    if (!d) {
      const h = this.hitTest(sx, sy);
      if (JSON.stringify(h) !== JSON.stringify(this.hover)) {
        this.hover = h;
        this.needsDraw = true;
      }
      if (this.calibrating) this.needsDraw = true;
      return;
    }
    const dx = w.x - d.startWorld.x, dz = w.z - d.startWorld.z;
    switch (d.kind) {
      case 'pan':
        this.view.pan(sx - d.startScreen[0], sy - d.startScreen[1]);
        d.startScreen = [sx, sy];
        break;
      case 'point': {
        const p = this.data.points[d.i];
        p.x = round(d.origin.x + dx);
        p.z = round(d.origin.z + dz);
        this.rebuild();
        break;
      }
      case 'hin':
      case 'hout': {
        const p = this.data.points[d.i];
        moveHandle(this.data, d.i, d.kind, { x: w.x - p.x, z: w.z - p.z }, e.altKey);
        this.rebuild();
        break;
      }
      case 'pit': {
        const p = this.data.pitLane!.points[d.i];
        p.x = round(d.origin.x + dx);
        p.z = round(d.origin.z + dz);
        this.rebuild();
        break;
      }
      case 'prop': {
        const p = this.data.props[d.i];
        p.x = round(d.origin.x + dx);
        p.z = round(d.origin.z + dz);
        break;
      }
      case 'bg':
        if (this.bg) {
          this.bg.x = d.origin.x + dx;
          this.bg.z = d.origin.z + dz;
        }
        break;
    }
    this.needsDraw = true;
  }

  private onUp(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'pan') return;
    if (d.kind === 'bg') return this.saveBackground();
    this.history.dropIfUnchanged(this.data);
    this.committed();
  }

  private onDouble(e: MouseEvent): void {
    if (this.tool !== 'select') return;
    const [sx, sy] = this.screenPos(e);
    if (this.hitTest(sx, sy)) return;
    const w = this.view.toWorld(sx, sy);
    const ref = nearestRef(this.data, w);
    const width = this.spline ? this.spline.samples[0].width : this.data.defaultWidth;
    if (ref.dist > Math.max(width, 12 / this.view.zoom)) return;
    this.change(() => {
      const i = insertPoint(this.data, ref.seg, ref.t);
      this.selection = { kind: 'point', i };
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (this.previewOpen) return;
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ') { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
    if (ctrl && e.code === 'KeyY') { e.preventDefault(); return this.redo(); }
    if (ctrl && e.code === 'KeyS') { e.preventDefault(); return void this.save(); }
    if (ctrl) return;
    if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); return this.deleteSelection(); }
    if (e.code === 'Escape') { this.calibrating = false; this.calib = []; return this.select(null); }
    if (e.code === 'KeyF') return this.fitView();
    if (e.code === 'KeyR' && this.selection?.kind === 'prop') {
      const i = this.selection.i;
      return this.change(() => (this.data.props[i].rot = (this.data.props[i].rot + (e.shiftKey ? -15 : 15) + 360) % 360));
    }
    const t = TOOLS.find((x) => 'Key' + x.key === e.code);
    if (t) this.setTool(t.id);
  }

  private finishCalibration(): void {
    const [a, b] = this.calib;
    this.calibrating = false;
    this.calib = [];
    if (!this.bg) return;
    const measured = Math.hypot(b.x - a.x, b.z - a.z);
    const ans = prompt(`Distanza attuale sullo sfondo: ${measured.toFixed(1)} m.\nQuanti metri è lunga DAVVERO questa distanza?`, measured.toFixed(0));
    const real = ans ? parseFloat(ans.replace(',', '.')) : NaN;
    if (!(real > 0)) return;
    const k = real / measured;
    // scala attorno al primo punto cliccato (resta fermo)
    this.bg.x = a.x + (this.bg.x - a.x) * k;
    this.bg.z = a.z + (this.bg.z - a.z) * k;
    this.bg.scale *= k;
    this.saveBackground();
    this.panel.render();
    this.needsDraw = true;
  }

  // ===================== disegno =====================

  draw(): void {
    this.needsDraw = false;
    drawEditor(this.ctx, this.view, {
      data: this.data,
      spline: this.spline,
      issues: this.issues,
      selection: this.selection,
      hover: this.hover,
      tool: this.tool,
      bg: this.bg,
      calib: this.calib,
      mouse: this.mouse,
    });
  }

  requestDraw(): void {
    this.needsDraw = true;
  }
}
