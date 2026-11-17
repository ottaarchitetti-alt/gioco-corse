/**
 * Barra strumenti e pannello proprietà dell'editor (HTML).
 * Il pannello cambia in base allo strumento attivo e a cosa è selezionato.
 */
import { PROP_CATALOG, PROP_TYPES } from '../track/props';
import type { HandleMode, KerbMode, PropType, Vec2 } from '../track/TrackData';
import type { Editor } from './Editor';
import { TOOLS } from './Editor';
import { freezeHandles, reverseTrack, round } from './trackOps';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const KERB_LABELS: Record<KerbMode, string> = {
  auto: 'Automatici (nelle curve)', none: 'Nessuno', left: 'Solo sinistra', right: 'Solo destra', both: 'Entrambi i lati',
};
const HANDLE_LABELS: Record<HandleMode, string> = {
  auto: 'Automatiche (curva morbida)', smooth: 'Manuali allineate', corner: 'Manuali indipendenti (spigolo)',
};

export class EditorPanel {
  private statusEl!: HTMLSpanElement;
  private cursorEl!: HTMLSpanElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;

  constructor(private ed: Editor, private toolbar: HTMLElement, private panel: HTMLElement) {
    this.buildToolbar();
  }

  private buildToolbar(): void {
    this.toolbar.innerHTML = `
      <button data-a="menu">◀ Menu</button>
      <div class="ed-tools">${TOOLS.map((t) => `<button data-tool="${t.id}" title="${esc(t.help)} (tasto ${t.key})">${t.label} <kbd>${t.key}</kbd></button>`).join('')}</div>
      <button data-a="undo" title="Ctrl+Z">↶ Annulla</button>
      <button data-a="redo" title="Ctrl+Y">↷ Ripeti</button>
      <button data-a="fit" title="Tasto F">Inquadra</button>
      <span class="ed-spacer"></span>
      <span class="ed-cursor mono"></span>
      <span class="ed-status"></span>
      <button data-a="preview">Anteprima 3D</button>
      <button data-a="export">Esporta</button>
      <button class="primary" data-a="play">▶ Guida</button>`;
    this.statusEl = this.toolbar.querySelector('.ed-status')!;
    this.cursorEl = this.toolbar.querySelector('.ed-cursor')!;
    this.undoBtn = this.toolbar.querySelector('[data-a="undo"]')!;
    this.redoBtn = this.toolbar.querySelector('[data-a="redo"]')!;
    this.toolbar.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
      b.addEventListener('click', () => this.ed.setTool(b.dataset.tool as never)),
    );
    const act: Record<string, () => void> = {
      menu: () => void this.ed.goMenu(),
      undo: () => this.ed.undo(),
      redo: () => this.ed.redo(),
      fit: () => this.ed.fitView(),
      preview: () => void this.ed.openPreview(),
      export: () => this.ed.exportFile(),
      play: () => void this.ed.playTrack(),
    };
    this.toolbar.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) => b.addEventListener('click', act[b.dataset.a!]));
  }

  renderStatus(): void {
    const s = this.ed.saveState;
    this.statusEl.textContent = s === 'salvato' ? '✓ Salvato' : s === 'errore' ? '⚠ Errore di salvataggio' : s === 'modificato' ? '● Modificato' : 'Salvataggio…';
    this.statusEl.className = 'ed-status ' + (s === 'errore' ? 'bad' : '');
    this.undoBtn.disabled = !this.ed.history.canUndo;
    this.redoBtn.disabled = !this.ed.history.canRedo;
  }

  renderCursor(w: Vec2): void {
    this.cursorEl.textContent = `x ${w.x.toFixed(0)}  z ${w.z.toFixed(0)} m`;
  }

  /** Ridisegna il pannello laterale. */
  render(): void {
    const ed = this.ed;
    this.toolbar.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
      b.classList.toggle('active', b.dataset.tool === ed.tool),
    );
    const help = ed.root.querySelector('.ed-help') as HTMLElement;
    help.textContent = ed.calibrating
      ? 'Calibrazione: clicca due punti dello sfondo di cui conosci la distanza reale.'
      : TOOLS.find((t) => t.id === ed.tool)!.help;

    const sections = [this.trackSection(), this.toolSection(), this.issuesSection()];
    this.panel.innerHTML = sections.join('');
    this.bindPanel();
    this.renderStatus();
  }

  // ---------- sezioni ----------

  private trackSection(): string {
    const d = this.ed.data, sp = this.ed.spline;
    let tight = '';
    if (sp) {
      const maxK = Math.max(...sp.samples.map((s) => Math.abs(s.curvature)));
      tight = `${(1 / Math.max(maxK, 1e-6)).toFixed(0)} m`;
    }
    return `
      <section>
        <h3>Pista</h3>
        <label>Nome <input data-f="name" value="${esc(d.name)}"></label>
        <label>Larghezza standard (m) <input type="number" min="6" max="30" step="0.5" data-f="defaultWidth" value="${d.defaultWidth}"></label>
        <label>Posti in griglia <input type="number" min="1" max="40" step="1" data-f="gridSlots" value="${d.gridSlots}"></label>
        <label class="row"><input type="checkbox" data-f="autoTrees" ${d.autoTrees ? 'checked' : ''}> Alberi automatici attorno</label>
        <div class="stats">
          Lunghezza <b>${sp ? (sp.length / 1000).toFixed(3) + ' km' : '–'}</b> · Punti <b>${d.points.length}</b><br>
          Curva più stretta: raggio <b>${tight || '–'}</b>
        </div>
        <button data-b="reverse">⇄ Inverti senso di marcia</button>
      </section>`;
  }

  private toolSection(): string {
    const ed = this.ed;
    switch (ed.tool) {
      case 'select':
      case 'add':
        return this.pointSection();
      case 'start':
        return `<section><h3>Partenza</h3><p>Clicca sulla pista dove vuoi la linea di partenza/arrivo. Il senso di marcia segue le frecce; la griglia (${ed.data.gridSlots} posti) si forma dietro la linea.</p></section>`;
      case 'sector': {
        const opts = [0, 1].map((i) => `<label class="row"><input type="radio" name="sec" data-sec="${i}" ${ed.sectorIndex === i ? 'checked' : ''}> Separatore S${i + 1} → S${i + 2}</label>`).join('');
        return `<section><h3>Settori</h3><p>La pista è divisa in 3 settori (tempi intermedi). Scegli quale separatore spostare, poi clicca sulla pista.</p>${opts}</section>`;
      }
      case 'pit':
        return this.pitSection();
      case 'props':
        return this.propsSection();
      case 'background':
        return this.bgSection();
    }
  }

  private pointSection(): string {
    const ed = this.ed, s = ed.selection;
    if (!s || (s.kind !== 'point' && s.kind !== 'hin' && s.kind !== 'hout')) {
      return `<section><h3>Punto</h3><p>Nessun punto selezionato. Clicca un punto bianco per modificarlo.</p></section>`;
    }
    const p = ed.data.points[s.i];
    const kerb = p.kerb ?? 'auto';
    const handle = p.handle ?? 'auto';
    return `
      <section>
        <h3>Punto ${s.i + 1}</h3>
        <div class="two">
          <label>X (m) <input type="number" step="1" data-p="x" value="${p.x}"></label>
          <label>Z (m) <input type="number" step="1" data-p="z" value="${p.z}"></label>
        </div>
        <label>Larghezza qui (m)
          <input type="number" min="6" max="30" step="0.5" data-p="width" value="${p.width ?? ''}" placeholder="standard (${ed.data.defaultWidth})">
        </label>
        <label>Cordoli nel tratto ${s.i + 1} → ${((s.i + 1) % ed.data.points.length) + 1}
          <select data-p="kerb">${(Object.keys(KERB_LABELS) as KerbMode[]).map((k) => `<option value="${k}" ${k === kerb ? 'selected' : ''}>${KERB_LABELS[k]}</option>`).join('')}</select>
        </label>
        <label>Maniglie
          <select data-p="handle">${(Object.keys(HANDLE_LABELS) as HandleMode[]).map((k) => `<option value="${k}" ${k === handle ? 'selected' : ''}>${HANDLE_LABELS[k]}</option>`).join('')}</select>
        </label>
        <button class="danger" data-b="delete">Elimina punto (Canc)</button>
      </section>`;
  }

  private pitSection(): string {
    const pl = this.ed.data.pitLane;
    if (!pl) {
      return `<section><h3>Corsia box</h3><p>Nessuna corsia box. Clicca per mettere il primo punto (ingresso, sul bordo della pista), poi gli altri fino all'uscita.</p></section>`;
    }
    const pit = this.ed.spline?.pit;
    return `
      <section>
        <h3>Corsia box</h3>
        <p>${pl.points.length} punti${pit ? ` · ${pit.length.toFixed(0)} m · ${pit.stalls.length} piazzole` : ''}. Il primo punto è l'ingresso.</p>
        <label>Larghezza (m) <input type="number" min="6" max="20" step="0.5" data-pit="width" value="${pl.width}"></label>
        <label>Limite di velocità (km/h) <input type="number" min="30" max="120" step="5" data-pit="speedLimitKmh" value="${pl.speedLimitKmh}"></label>
        <label>Numero di box <input type="number" min="1" max="20" step="1" data-pit="garages" value="${pl.garages}"></label>
        <label>Lato dei box
          <select data-pit="garageSide"><option value="left" ${pl.garageSide === 'left' ? 'selected' : ''}>Sinistra</option><option value="right" ${pl.garageSide === 'right' ? 'selected' : ''}>Destra</option></select>
        </label>
        <button class="danger" data-b="pitclear">Elimina corsia box</button>
      </section>`;
  }

  private propsSection(): string {
    const ed = this.ed, s = ed.selection;
    const typeSel = (val: PropType, attr: string) =>
      `<select ${attr}>${PROP_TYPES.map((t) => `<option value="${t}" ${t === val ? 'selected' : ''}>${PROP_CATALOG[t].label}</option>`).join('')}</select>`;
    let sel = '<p>Clicca un oggetto per modificarlo.</p>';
    if (s?.kind === 'prop') {
      const p = ed.data.props[s.i];
      const info = PROP_CATALOG[p.type];
      sel = `
        <h3>Oggetto selezionato</h3>
        <label>Tipo ${typeSel(p.type, 'data-prop="type"')}</label>
        <label>${p.type === 'albero' ? 'Diametro' : 'Lunghezza'} (m) <input type="number" min="${info.minSize}" max="${info.maxSize}" step="1" data-prop="size" value="${p.size}"></label>
        <label>Rotazione (°) <input type="number" step="15" data-prop="rot" value="${p.rot}"></label>
        ${p.type === 'modello' ? `<label>File GLB (in public/) <input data-prop="model" value="${esc(p.model ?? 'models/props/')}"></label>` : ''}
        <button class="danger" data-b="propdel">Elimina oggetto (Canc)</button>`;
    }
    return `
      <section>
        <h3>Oggetti</h3>
        <label>Da piazzare ${typeSel(ed.propType, 'data-proptype')}</label>
        <p class="small">La striscia chiara indica il lato "frontale" (es. dove guardano le tribune).</p>
        ${sel}
      </section>`;
  }

  private bgSection(): string {
    const bg = this.ed.bg;
    return `
      <section>
        <h3>Immagine di sfondo</h3>
        <p class="small">Utile per ricalcare un circuito vero da una foto satellitare. Resta solo nell'editor, non nel gioco.</p>
        <label class="file">Carica immagine… <input type="file" accept="image/*" data-bgfile></label>
        ${bg ? `
          <label>Opacità <input type="range" min="0.1" max="1" step="0.05" data-bg="opacity" value="${bg.opacity}"></label>
          <label>Scala (m per pixel) <input type="number" step="0.01" data-bg="scale" value="${round(bg.scale, 1000)}"></label>
          <button data-b="calib">Calibra scala con 2 clic</button>
          <button class="danger" data-b="bgdel">Rimuovi sfondo</button>` : ''}
      </section>`;
  }

  private issuesSection(): string {
    const list = this.ed.issues;
    if (!list.length) return `<section><h3>Controlli</h3><p class="ok">✓ Nessun problema trovato</p></section>`;
    return `<section><h3>Controlli</h3><ul class="issues">${list.map((is, i) => `<li class="${is.level === 'errore' ? 'bad' : 'warn'}" data-issue="${i}">${is.level === 'errore' ? '⛔' : '⚠'} ${esc(is.message)}</li>`).join('')}</ul></section>`;
  }

  // ---------- eventi ----------

  private bindPanel(): void {
    const ed = this.ed;
    const q = <T extends Element>(sel: string) => Array.from(this.panel.querySelectorAll<T & HTMLElement>(sel));
    const num = (el: HTMLInputElement) => parseFloat(el.value.replace(',', '.'));

    // Pista
    q<HTMLInputElement>('[data-f]').forEach((el) =>
      el.addEventListener('change', () => {
        const f = el.dataset.f!;
        ed.change(() => {
          if (f === 'name') ed.data.name = el.value.trim() || 'Senza nome';
          if (f === 'defaultWidth' && num(el) >= 6) ed.data.defaultWidth = num(el);
          if (f === 'gridSlots' && num(el) >= 1) ed.data.gridSlots = Math.round(num(el));
          if (f === 'autoTrees') ed.data.autoTrees = el.checked;
        });
      }),
    );

    // Punto selezionato
    const s = ed.selection;
    q<HTMLInputElement | HTMLSelectElement>('[data-p]').forEach((el) =>
      el.addEventListener('change', () => {
        if (!s || !('i' in s)) return;
        const p = ed.data.points[s.i];
        const f = el.dataset.p!;
        ed.change(() => {
          if (f === 'x' || f === 'z') p[f] = num(el as HTMLInputElement);
          if (f === 'width') {
            const v = num(el as HTMLInputElement);
            if (v >= 6) p.width = v; else delete p.width;
          }
          if (f === 'kerb') p.kerb = el.value as KerbMode;
          if (f === 'handle') {
            const m = el.value as HandleMode;
            if (m === 'auto') { p.handle = 'auto'; delete p.hin; delete p.hout; }
            else freezeHandles(ed.data, s.i, m);
          }
        });
      }),
    );

    // Settori
    q<HTMLInputElement>('[data-sec]').forEach((el) =>
      el.addEventListener('change', () => { ed.sectorIndex = parseInt(el.dataset.sec!); }),
    );

    // Corsia box
    q<HTMLInputElement | HTMLSelectElement>('[data-pit]').forEach((el) =>
      el.addEventListener('change', () => {
        const pl = ed.data.pitLane!;
        const f = el.dataset.pit!;
        ed.change(() => {
          if (f === 'garageSide') pl.garageSide = el.value as 'left' | 'right';
          else if (f === 'width' || f === 'speedLimitKmh' || f === 'garages') {
            const v = num(el as HTMLInputElement);
            if (v > 0) pl[f] = f === 'garages' ? Math.round(v) : v;
          }
        });
      }),
    );

    // Oggetti
    q<HTMLSelectElement>('[data-proptype]').forEach((el) =>
      el.addEventListener('change', () => { ed.propType = el.value as PropType; }),
    );
    q<HTMLInputElement | HTMLSelectElement>('[data-prop]').forEach((el) =>
      el.addEventListener('change', () => {
        if (s?.kind !== 'prop') return;
        const p = ed.data.props[s.i];
        const f = el.dataset.prop!;
        ed.change(() => {
          if (f === 'type') {
            p.type = el.value as PropType;
            p.size = PROP_CATALOG[p.type].defaultSize;
          }
          if (f === 'size' && num(el as HTMLInputElement) > 0) p.size = num(el as HTMLInputElement);
          if (f === 'rot') p.rot = ((num(el as HTMLInputElement) % 360) + 360) % 360;
          if (f === 'model') p.model = el.value.trim();
        });
      }),
    );

    // Sfondo
    q<HTMLInputElement>('[data-bgfile]').forEach((el) =>
      el.addEventListener('change', () => {
        const f = el.files?.[0];
        if (f) void ed.loadBackgroundFile(f).catch((e) => alert(`Immagine non valida: ${e}`));
      }),
    );
    q<HTMLInputElement>('[data-bg]').forEach((el) =>
      el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
        if (!ed.bg) return;
        const v = num(el);
        if (!(v > 0)) return;
        if (el.dataset.bg === 'opacity') ed.bg.opacity = v;
        else ed.bg.scale = v;
        ed.saveBackground();
        ed.requestDraw();
      }),
    );

    // Pulsanti
    const buttons: Record<string, () => void> = {
      reverse: () => ed.change(() => reverseTrack(ed.data)),
      delete: () => ed.deleteSelection(),
      propdel: () => ed.deleteSelection(),
      pitclear: () => {
        if (confirm('Eliminare la corsia box? (puoi annullare con Ctrl+Z)')) {
          ed.change(() => delete ed.data.pitLane);
          ed.select(null);
        }
      },
      calib: () => { ed.startCalibration(); this.render(); },
      bgdel: () => ed.removeBackground(),
    };
    q<HTMLButtonElement>('[data-b]').forEach((b) => b.addEventListener('click', buttons[b.dataset.b!]));

    // Avvisi: clic → centra la vista
    q<HTMLLIElement>('[data-issue]').forEach((li) =>
      li.addEventListener('click', () => {
        const is = ed.issues[parseInt(li.dataset.issue!)];
        ed.centerOn(is.x, is.z);
      }),
    );
  }
}
