/**
 * Il "regista": carica auto e pista, crea tutti i sistemi e li collega.
 *
 * Gestisce le SESSIONI (prove libere, qualifica, gara): posizione di partenza,
 * cronometraggio, record personali, fantasma, risultati.
 * I concorrenti della sessione sono per ora solo il pilota; nella Fase 5 si
 * aggiungeranno i bot con lo stesso meccanismo (Competitor).
 */
import { EngineSound } from '../audio/EngineSound';
import { GameLoop } from '../core/GameLoop';
import { formatLapTime, MS_TO_KMH } from '../core/math';
import { loadJSON, saveJSON } from '../core/storage';
import { InputManager, emptyInput } from '../input/InputManager';
import { loadCar, type CarParams } from '../physics/CarParams';
import { Vehicle, type DrivingAids, type GroundContact, type Surface } from '../physics/Vehicle';
import { GhostPlayer, GhostRecorder } from '../race/Ghost';
import type { LapRecord, TimingEvent } from '../race/LapTiming';
import { Competitor, Session, SESSION_NAMES, type SessionConfig, type SessionEvent } from '../race/Session';
import { loadCarRig } from '../render/AssetManager';
import { CameraRig } from '../render/CameraRig';
import { CarView } from '../render/CarView';
import { Renderer } from '../render/Renderer';
import { RecordStore, type LapRecordData } from '../storage/RecordStore';
import { TrackStore } from '../storage/TrackStore';
import { geometryHash } from '../track/TrackData';
import { buildTrackMesh } from '../track/TrackMeshBuilder';
import { KERB_WIDTH, TrackSpline } from '../track/TrackSpline';
import { DebugPanel, type SimSettings } from '../ui/DebugPanel';
import { Hud, type SectorColor, type TimingHud } from '../ui/Hud';
import { Overlay } from '../ui/Overlay';
import { navigate } from '../ui/router';
import { TelemetryGraph } from '../ui/TelemetryGraph';

const CAR_URL = 'cars/gt_segnaposto.car.json';

/** Superfici (Fase 7/8: valori diversi con pioggia, sporco, gomma depositata). */
const SURFACES: Record<Surface['name'], Surface> = {
  asfalto: { name: 'asfalto', grip: 1, drag: 0 },
  cordolo: { name: 'cordolo', grip: 0.93, drag: 0.005 },
  erba: { name: 'erba', grip: 0.55, drag: 0.06 },
};

const DEFAULT_AIDS: DrivingAids = { abs: true, tc: true, autoShift: true, keyboardSteerAssist: true };
const DEFAULT_SIM: SimSettings = { airTemp: 22, trackTemp: 32, wearMultiplier: 1, tyreBlankets: false };
const DEFAULT_SESSION: SessionConfig = { type: 'libere', minutes: 0, laps: 5 };
/** Temperatura delle gomme montate con le termocoperte (°C) */
const BLANKET_TEMP = 80;

const fmtClock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class Game {
  private renderer!: Renderer;
  private input = new InputManager();
  private sound = new EngineSound();
  private aids: DrivingAids = loadJSON('aids', DEFAULT_AIDS);
  private sim: SimSettings = loadJSON('sim', DEFAULT_SIM);
  private sessionCfg: SessionConfig = loadJSON('session', DEFAULT_SESSION);
  private prefs = loadJSON('prefs', { ghost: true });
  private graph!: TelemetryGraph;
  private car!: CarParams;
  private track!: TrackSpline;
  private vehicle!: Vehicle;
  private view!: CarView;
  private cameras!: CameraRig;
  private hud!: Hud;
  private overlay!: Overlay;
  private debug!: DebugPanel;
  private loop!: GameLoop;

  // ---- Sessione ----
  private session!: Session;
  private player!: Competitor;
  /** Punto di partenza (per la partenza anticipata) */
  private startPos = { x: 0, z: 0 };
  private resultsTimer = 0;

  // ---- Record e fantasma ----
  private recordKey = '';
  private record: LapRecordData | null = null;
  /** Miglior settore di sempre (anche se il giro record è un altro) */
  private bestSectorsEver: (number | null)[] = [];
  private ghostRec = new GhostRecorder();
  private ghost!: GhostPlayer;
  private sessionGhost: number[] | null = null;
  /** Settori del giro appena concluso, mostrati per qualche secondo nel giro nuovo */
  private lastLapShown: LapRecord | null = null;

  /** Ultimo indice di campione pista per ogni ruota e per il baricentro (ricerca veloce). */
  private wheelHints = [-1, -1, -1, -1];
  private pitHints = [-1, -1, -1, -1];
  private carHint = -1;
  private carS = 0;
  private carD = 0;
  private telemetryTimer = 0;
  private lastSteer = 0;
  private started = false;
  private lapListOn = false;
  /** Se false i giri non diventano record (usato dagli strumenti di sviluppo) */
  recordsEnabled = true;

  /**
   * @param trackId pista da caricare (inclusa o creata con l'editor)
   * @param fromEditor true se si arriva dall'editor: nel menu di pausa c'è "Torna all'editor"
   */
  constructor(private appEl: HTMLElement, private uiEl: HTMLElement, private trackId: string, private fromEditor = false) {}

  async init(): Promise<void> {
    this.overlay = new Overlay(this.uiEl);
    this.renderer = new Renderer(this.appEl);

    // ---- Dati ----
    const [car, trackData] = await Promise.all([loadCar(CAR_URL), TrackStore.load(this.trackId)]);
    this.car = car;
    this.input.carSteeringLockDeg = car.steeringLockDeg;

    // ---- Modello auto (GLB o segnaposto) ----
    const rig = await loadCarRig(car, '#d8231f');
    if (car.geometryFromModel && rig.source === 'glb' && rig.measured) {
      // Passo, carreggiate e raggio ruota letti dal tuo modello Blender
      Object.assign(car, rig.measured);
      console.info('[Game] Geometria letta dal modello:', rig.measured);
    }
    this.renderer.scene.add(rig.root);
    this.ghost = new GhostPlayer(rig.root);
    this.renderer.scene.add(this.ghost.object);

    // ---- Pista ----
    this.track = new TrackSpline(trackData);
    this.renderer.scene.add(buildTrackMesh(this.track, this.renderer.maxAnisotropy));

    // ---- Record personale (legato alla geometria: se modifichi la pista riparte da zero) ----
    this.recordKey = RecordStore.key(`${trackData.id}_${geometryHash(trackData)}`, car.id);
    try {
      this.record = (await RecordStore.load(this.recordKey)) ?? null;
    } catch (e) {
      console.warn('Record non disponibili:', e);
    }
    this.bestSectorsEver = this.record ? [...this.record.bestSectors] : [];

    // ---- Fisica ----
    this.vehicle = new Vehicle(car, (i, x, z) => this.groundAt(i, x, z));
    this.applySim();

    // ---- Vista, HUD ----
    this.view = new CarView(rig, this.vehicle);
    this.cameras = new CameraRig(this.renderer.camera, this.view);
    this.hud = new Hud(this.uiEl);
    this.graph = new TelemetryGraph(this.uiEl);
    this.debug = new DebugPanel(car, this.aids, this.sim, {
      onAidsChange: () => saveJSON('aids', this.aids),
      onSimChange: () => {
        saveJSON('sim', this.sim);
        this.applySim();
      },
      onNewTyres: () => {
        this.fitNewTyres();
        this.hud.message(`Gomme nuove: ${this.vehicle.tires[0].compound.name}`, 2);
      },
    }, this.input, this.sound);

    // ---- Loop ----
    this.loop = new GameLoop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      render: (alpha, frameDt) => this.render(alpha, frameDt),
    });
    // sessione "di attesa" dietro la schermata di scelta
    this.startSession(this.sessionCfg, false);
    this.loop.paused = true;
    this.loop.start();
    this.showSessionChoice();
  }

  // =====================================================================
  //  SESSIONI
  // =====================================================================

  private showSessionChoice(): void {
    this.loop.paused = true;
    this.overlay.showStart(
      this.track.data.name, this.car.name,
      this.record ? formatLapTime(this.record.lapTime) : 'nessuno',
      this.sessionCfg,
      (cfg) => {
        this.started = true;
        this.sound.start();
        this.sound.setPaused(false);
        this.startSession(cfg);
      },
    );
  }

  /** Prepara e avvia una sessione. */
  startSession(cfg: SessionConfig, run = true): void {
    this.sessionCfg = { ...cfg };
    saveJSON('session', this.sessionCfg);
    this.session = new Session(this.sessionCfg, this.track.length, (e) => this.onSessionEvent(e));
    this.player = new Competitor('pilota', 'Tu', true, this.track.length, this.track.sectorS, (c, e) => this.onTimingEvent(c, e));
    this.session.add(this.player);
    this.sessionGhost = null;
    this.lastLapShown = null;
    this.resultsTimer = 0;
    this.ghostRec.restart();
    this.fitNewTyres();

    // Partenza: in gara dalla griglia; in prova/qualifica dai box (se ci sono)
    if (this.session.isRace) this.placeOnGrid(0);
    else if (!this.placeInPits()) this.placeOnTrack(this.track.length - 150);
    this.startPos = { x: this.vehicle.x, z: this.vehicle.z };
    this.player.timing.resetPosition();

    this.hud?.showLapList(null);
    this.hud?.clearMessage();
    this.lapListOn = false;
    if (run) {
      this.overlay.hide();
      this.loop.paused = false;
      this.hud.message(this.session.isRace ? 'Gara: attendi lo spegnimento dei semafori' : `${this.session.name}: buon lavoro!`, 3);
    }
  }

  private onSessionEvent(e: SessionEvent): void {
    switch (e.type) {
      case 'go':
        this.hud.message('VIA!', 1.5);
        break;
      case 'jumpStart':
        if (e.c.isPlayer) this.hud.message('Partenza anticipata: +5 s di penalità', 4);
        break;
      case 'flag':
        this.hud.message(this.session.isRace ? '🏁 Bandiera a scacchi' : '🏁 Tempo scaduto: completa il giro', 4);
        break;
      case 'finished':
        if (e.c.isPlayer) this.hud.message('🏁 Traguardo!', 3);
        break;
      case 'end':
        this.resultsTimer = 2.5; // risultati dopo qualche secondo
        break;
    }
  }

  private onTimingEvent(c: Competitor, e: TimingEvent): void {
    if (!c.isPlayer) return;
    switch (e.type) {
      case 'invalidated':
        this.hud.message(`Giro non valido: ${e.reason}`, 2);
        break;
      case 'sector':
        if (c.timing.valid) this.updateBestSectorEver(e.index, e.time);
        break;
      case 'lap': {
        const lap = e.lap;
        this.lastLapShown = lap;
        if (lap.valid) this.updateBestSectorEver(lap.sectors.length - 1, lap.sectors[lap.sectors.length - 1]!);
        if (e.sessionBest) this.sessionGhost = this.ghostRec.result;
        const isRecord = this.recordsEnabled && lap.valid && (!this.record || lap.time < this.record.lapTime);
        if (isRecord) this.saveRecord(lap);
        const txt = formatLapTime(lap.time);
        this.hud.message(isRecord ? `🏆 Nuovo record! ${txt}` : lap.valid ? `Giro ${lap.lap}: ${txt}` : `Giro ${lap.lap} (non valido): ${txt}`, 3);
        if (this.lapListOn) this.hud.showLapList(this.lapTableHtml());
        break;
      }
      case 'lineCrossed':
        this.session.onLineCrossed(c);
        this.ghostRec.restart();
        break;
    }
  }

  private updateBestSectorEver(i: number, time: number): void {
    const cur = this.bestSectorsEver[i];
    if (!this.recordsEnabled) return;
    if (cur === undefined || cur === null || time < cur) {
      this.bestSectorsEver[i] = time;
      if (this.record) {
        this.record.bestSectors = [...this.bestSectorsEver];
        void RecordStore.save(this.recordKey, this.record);
      }
    }
  }

  private saveRecord(lap: LapRecord): void {
    this.record = {
      lapTime: lap.time,
      sectors: lap.sectors.map((s) => s ?? 0),
      bestSectors: [...this.bestSectorsEver],
      trace: this.player.timing.bestTrace ?? [],
      ghost: this.ghostRec.result,
      date: Date.now(),
      compound: this.vehicle.tires[0].compound.name,
    };
    void RecordStore.save(this.recordKey, this.record).catch((err) => console.warn('Salvataggio record fallito', err));
  }

  /** Riferimento per delta e fantasma: il più veloce tra record e miglior giro della sessione. */
  private reference(): { trace: number[] | null; ghost: number[] | null; label: string } {
    const sb = this.player.timing.best;
    if (sb && (!this.record || sb.time <= this.record.lapTime)) {
      return { trace: this.player.timing.bestTrace, ghost: this.sessionGhost, label: 'miglior giro' };
    }
    if (this.record) return { trace: this.record.trace, ghost: this.record.ghost, label: 'record' };
    return { trace: null, ghost: null, label: '' };
  }

  private sectorColor(i: number, time: number, valid: boolean): SectorColor {
    if (!valid) return 'giallo';
    const ever = this.bestSectorsEver[i];
    if (ever !== undefined && ever !== null && time <= ever + 1e-6) return 'viola';
    const sb = this.player.timing.bestSectors[i];
    if (sb !== null && time <= sb + 1e-6) return 'verde';
    return 'giallo';
  }

  private endSessionEarly(): void {
    if (this.session.state !== 'finita') this.session.end();
    this.resultsTimer = 0.01;
    this.togglePause(false);
  }

  private showResults(): void {
    this.loop.paused = true;
    const s = this.session;
    const rows = s.standings().map((c) => {
      const best = c.timing.best ? formatLapTime(c.timing.best.time) : '–';
      if (s.isRace) {
        const total = c.finishTime !== null ? formatLapTime(c.finishTime + c.penalty) : 'non arrivato';
        return `<tr class="${c.isPlayer ? 'me' : ''}"><td>${c.position}</td><td>${c.name}</td><td>${c.lapsDone}</td><td>${total}${c.penalty ? ` <small>(+${c.penalty} s)</small>` : ''}</td><td>${s.gap(c)}</td><td>${best}</td></tr>`;
      }
      return `<tr class="${c.isPlayer ? 'me' : ''}"><td>${c.position}</td><td>${c.name}</td><td>${best}</td><td>${s.gap(c)}</td><td>${c.lapsDone}</td></tr>`;
    }).join('');
    const head = s.isRace
      ? '<tr><th>Pos</th><th>Pilota</th><th>Giri</th><th>Tempo</th><th>Distacco</th><th>Giro migliore</th></tr>'
      : '<tr><th>Pos</th><th>Pilota</th><th>Giro migliore</th><th>Distacco</th><th>Giri</th></tr>';
    const html = `
      <p>${this.track.data.name} · ${this.car.name}</p>
      <h2>Classifica</h2><table class="results">${head}${rows}</table>
      <h2>I tuoi giri</h2>${this.lapTableHtml(true)}`;
    const actions: { label: string; act: () => void; primary?: boolean }[] = [];
    if (s.config.type === 'qualifica') {
      actions.push({ label: '▶ Vai in gara', primary: true, act: () => this.startSession({ ...this.sessionCfg, type: 'gara' }) });
    }
    actions.push(
      { label: '↻ Ripeti sessione', primary: s.config.type !== 'qualifica', act: () => this.startSession(this.sessionCfg) },
      { label: 'Altra sessione…', act: () => this.showSessionChoice() },
      ...(this.fromEditor ? [{ label: "✎ Torna all'editor", act: () => navigate('editor', { pista: this.trackId }) }] : []),
      { label: 'Menu principale', act: () => navigate('menu') },
    );
    this.overlay.showResults(`${SESSION_NAMES[s.config.type]} · Risultati`, html, actions);
  }

  /** Tabella dei giri del pilota, con settori colorati e giro ideale. */
  private lapTableHtml(forResults = false): string {
    const t = this.player.timing;
    if (!t.laps.length) return '<p>Nessun giro completato.</p>';
    const nS = t.sectorCount;
    const head = `<tr><th>Giro</th><th>Tempo</th>${Array.from({ length: nS }, (_, i) => `<th>S${i + 1}</th>`).join('')}</tr>`;
    const best = t.best;
    const rows = t.laps.map((l) => {
      const cls = !l.valid ? 'inv' : best && l === best ? 'verde' : '';
      const sec = l.sectors.map((x, i) => {
        if (x === null) return '<td>–</td>';
        const c = l.valid && t.bestSectors[i] !== null && x <= t.bestSectors[i]! + 1e-6 ? 'verde' : '';
        return `<td class="${c}">${x.toFixed(3)}</td>`;
      }).join('');
      return `<tr><td>${l.lap}</td><td class="${cls}">${formatLapTime(l.time)}</td>${sec}</tr>`;
    }).join('');
    const ideal = t.bestSectors.every((x) => x !== null)
      ? `<p>Giro ideale (somma dei migliori settori): <b>${formatLapTime(t.bestSectors.reduce((a, b) => a! + b!, 0)!)}</b></p>`
      : '';
    return `<table class="${forResults ? 'results' : ''}">${head}${rows}</table>${ideal}`;
  }

  // =====================================================================
  //  POSIZIONAMENTO
  // =====================================================================

  /** Mette l'auto ferma in un posto della griglia di partenza (0 = pole position). */
  private placeOnGrid(slot: number): void {
    const g = this.track.grid[slot];
    if (!g) return this.placeOnTrack(this.track.length - 30);
    this.placeAt(g.x, g.z, g.heading);
  }

  /** Davanti al box più vicino all'uscita della corsia box. */
  private placeInPits(): boolean {
    const pit = this.track.pit;
    if (!pit || !pit.stalls.length) return false;
    const st = pit.stalls.reduce((a, b) => (b.s > a.s ? b : a));
    this.placeAt(st.x, st.z, st.heading);
    return true;
  }

  /** Mette l'auto ferma sulla linea centrale alla distanza s. */
  private placeOnTrack(s: number): void {
    const smp = this.track.atS(s);
    this.placeAt(smp.x, smp.z, smp.heading);
  }

  private placeAt(x: number, z: number, heading: number): void {
    this.vehicle.reset(x, z, heading);
    const idx = this.track.project(x, z).index;
    this.wheelHints = [idx, idx, idx, idx];
    this.pitHints = [-1, -1, -1, -1];
    this.carHint = idx;
    this.carS = this.track.project(x, z).s;
  }

  private resetToTrack(): void {
    this.placeOnTrack(this.carS);
    this.player.timing.invalidate('auto riposizionata');
    this.player.timing.resetPosition();
  }

  // =====================================================================
  //  FISICA E AMBIENTE
  // =====================================================================

  /** Condizioni ambientali → fisica delle gomme. */
  private applySim(): void {
    this.vehicle.env.airTemp = this.sim.airTemp;
    this.vehicle.env.trackTemp = this.sim.trackTemp;
    this.vehicle.env.wearMultiplier = this.sim.wearMultiplier;
  }

  /** Monta gomme nuove secondo l'assetto (mescola e pressioni a freddo). */
  private fitNewTyres(): void {
    const s = this.car.setup;
    const start = this.sim.tyreBlankets ? BLANKET_TEMP : this.sim.airTemp + 3;
    this.vehicle.fitTyres(s.compound, s.pressureFront, s.pressureRear, start);
  }

  /**
   * Cosa c'è sotto una ruota: asfalto, cordolo o erba (dalla distanza dal centro pista)
   * e l'altezza del suolo: i cordoli sono rialzati e "a dente", l'erba è irregolare.
   */
  private groundAt(i: number, x: number, z: number): GroundContact {
    const p = this.track.project(x, z, this.wheelHints[i]);
    this.wheelHints[i] = p.index;
    const half = p.sample.width / 2;
    const ad = Math.abs(p.d);
    if (ad <= half) return { surface: SURFACES.asfalto, height: 0 };
    const hasKerb = p.d > 0 ? p.sample.kerbLeft : p.sample.kerbRight;
    if (hasKerb && ad <= half + KERB_WIDTH) {
      const rise = Math.min(1, (ad - half) / 0.4); // il cordolo sale nei primi 40 cm
      const teeth = Math.abs(Math.sin((Math.PI * p.s) / 1.2)); // dentini ogni 1,2 m
      return { surface: SURFACES.cordolo, height: 0.022 * rise + 0.004 * teeth * rise };
    }
    // corsia box: asfalto anche fuori dalla carreggiata della pista
    const pit = this.track.pit;
    if (pit) {
      const q = pit.project(x, z, this.pitHints[i]);
      this.pitHints[i] = q.index;
      if (q.s > -3 && q.s < pit.length + 3 && Math.abs(q.d) <= pit.data.width / 2) return { surface: SURFACES.asfalto, height: 0 };
    }
    const bumps = 0.012 * (Math.sin(p.s * 0.9) + Math.sin(p.d * 1.7 + p.s * 0.31)) * 0.5;
    return { surface: SURFACES.erba, height: bumps };
  }

  private fixedUpdate(dt: number): void {
    const finished = this.session.state === 'finita';
    // a sessione finita il pilota non guida più (l'auto rallenta da sola)
    const input = finished ? { ...emptyInput(), brake: 0.3 } : this.input.read(dt, this.vehicle.speed, this.aids.keyboardSteerAssist);
    this.lastSteer = input.steer;
    this.vehicle.step(dt, input, this.aids);

    const p = this.track.project(this.vehicle.x, this.vehicle.z, this.carHint);
    this.carHint = p.index;
    this.carS = p.s;
    this.carD = p.d;
    const allOff = this.vehicle.surfaces.every((s) => s.name === 'erba');
    this.player.timing.update(dt, p.s, allOff);
    if (this.player.timing.lap > 0) this.ghostRec.sample(this.player.timing.current, this.vehicle.x, this.vehicle.z, this.vehicle.yaw);
    this.session.update(dt, () => Math.hypot(this.vehicle.x - this.startPos.x, this.vehicle.z - this.startPos.z));

    // Rete di sicurezza: troppo lontani dalla pista → si torna in pista
    if (Math.abs(p.d) > 120) this.resetToTrack();
  }

  // =====================================================================
  //  INPUT DI GIOCO, PAUSA
  // =====================================================================

  private handleActions(): void {
    for (const a of this.input.consumeActions()) {
      if (!this.started) continue;
      switch (a) {
        case 'camera':
          this.hud.message(`Telecamera: ${this.cameras.next()}`, 1);
          break;
        case 'reset':
          if (this.session.state !== 'semaforo') this.resetToTrack();
          break;
        case 'pause':
          if (this.session.state !== 'finita' || !this.loop.paused) this.togglePause();
          break;
        case 'help':
          if (!this.loop.paused) this.togglePause();
          break;
        case 'telemetry':
          this.hud.telemetry.classList.toggle('show');
          if (this.hud.telemetry.classList.contains('show')) { this.lapListOn = false; this.hud.showLapList(null); }
          break;
        case 'laps':
          this.lapListOn = !this.lapListOn;
          this.hud.showLapList(this.lapListOn ? this.lapTableHtml() : null);
          if (this.lapListOn) this.hud.telemetry.classList.remove('show');
          break;
        case 'ghost':
          this.prefs.ghost = !this.prefs.ghost;
          saveJSON('prefs', this.prefs);
          this.hud.message(`Fantasma ${this.prefs.ghost ? 'attivo' : 'nascosto'}`, 1);
          break;
        case 'graphs':
          this.graph.setVisible(!this.graph.visible);
          break;
        case 'mute':
          this.hud.message(this.sound.toggleMute() ? 'Audio disattivato' : 'Audio attivo', 1);
          break;
        case 'debug':
          this.debug.toggle();
          break;
      }
    }
  }

  private togglePause(show = true): void {
    if (this.loop.paused) {
      this.overlay.hide();
      this.loop.paused = false;
      this.sound.setPaused(false);
    } else {
      this.loop.paused = true;
      this.sound.setPaused(true);
      if (!show) return;
      this.overlay.showPause(() => this.togglePause(), [
        { label: '↻ Ricomincia sessione', act: () => this.startSession(this.sessionCfg) },
        { label: '🏁 Termina e vedi risultati', act: () => this.endSessionEarly() },
        { label: 'Cambia sessione…', act: () => this.showSessionChoice() },
        ...(this.fromEditor ? [{ label: "✎ Torna all'editor", act: () => navigate('editor', { pista: this.trackId }) }] : []),
        { label: 'Menu principale', act: () => navigate('menu') },
      ]);
    }
  }

  // =====================================================================
  //  DISEGNO E HUD
  // =====================================================================

  private timingHud(): TimingHud {
    const s = this.session, t = this.player.timing;
    let info = '';
    if (s.state === 'semaforo') info = 'Partenza';
    else if (s.state === 'bandiera') info = '🏁 Bandiera';
    else if (s.state === 'finita') info = 'Finita';
    else if (s.isRace) info = `Giro ${Math.min(Math.max(t.lap, 1), s.config.laps)}/${s.config.laps}`;
    else if (s.timeLeft !== null) info = fmtClock(s.timeLeft);
    else info = fmtClock(s.clock);

    const ref = this.reference();
    // settori: quelli del giro in corso; nei primi 4 s di un giro, quelli del giro appena chiuso
    const showLast = this.lastLapShown && t.current < 4 && t.sectorIndex === 0;
    const secs = showLast ? this.lastLapShown!.sectors : t.currentSectors;
    const valid = showLast ? this.lastLapShown!.valid : t.valid;
    return {
      sessionName: s.name,
      sessionInfo: info,
      position: this.player.position,
      total: s.competitors.length,
      lap: t.lap,
      current: t.current,
      delta: s.isRace ? null : t.deltaAt(this.carS, ref.trace),
      deltaRef: ref.label,
      valid: t.valid,
      lastLap: t.laps.length ? t.laps[t.laps.length - 1].time : null,
      bestLap: t.best?.time ?? null,
      recordLap: this.record?.lapTime ?? null,
      sectors: secs.map((x, i) => ({ time: x, color: x === null ? '' : this.sectorColor(i, x, valid) })),
    };
  }

  private render(alpha: number, frameDt: number): void {
    this.handleActions();
    const v = this.vehicle;
    this.view.update(alpha);
    this.cameras.update(frameDt, v.speed);
    this.renderer.followShadows(this.view.position);

    if (this.resultsTimer > 0) {
      this.resultsTimer -= frameDt;
      if (this.resultsTimer <= 0) this.showResults();
    }

    // Fantasma: solo in prove/qualifica, durante un giro lanciato
    const t = this.player.timing;
    const showGhost = this.prefs.ghost && !this.session.isRace && t.lap > 0 && this.session.state !== 'finita';
    this.ghost.data = showGhost ? this.reference().ghost : null;
    this.ghost.update(showGhost ? t.current : null, v.car.wheelbase / 2 - v.cgToFront);

    const dt = v.drivetrain;
    this.hud.update({
      speedKmh: v.speed * MS_TO_KMH,
      gear: dt.gear,
      rpm: dt.rpm,
      maxRpm: this.car.maxRpm,
      shifting: dt.isShifting,
      timing: this.timingHud(),
      standings: this.session.standings().map((c) => ({ pos: c.position, name: c.name, gap: this.session.gap(c), player: c.isPlayer })),
      lights: this.session.state === 'semaforo' ? this.session.lights : -1,
      throttle: v.appliedThrottle,
      brake: v.appliedBrake,
      steer: this.lastSteer,
      abs: this.aids.abs,
      absActive: v.absActive,
      tc: this.aids.tc,
      tcActive: v.tcActive,
      autoShift: this.aids.autoShift,
      camera: this.cameras.mode,
      device: this.input.device,
      trackName: this.track.data.name,
      carName: this.car.name,
      compound: v.tires[0].compound.name,
      tyres: v.tires.map((ty) => ({
        temp: ty.surfaceTemp, core: ty.coreTemp, pressure: ty.pressure,
        tread: ty.tread, grip: ty.gripFactor, optimal: ty.compound.optimalTemp,
      })),
    }, frameDt);

    const avgT = (a: number, b: number) => (v.tires[a].effectiveTemp + v.tires[b].effectiveTemp) / 2;
    this.graph.push(frameDt, [
      v.speed * MS_TO_KMH, v.appliedThrottle, v.appliedBrake, this.lastSteer,
      v.aLatSmooth / 9.81, avgT(0, 1), avgT(2, 3),
    ]);

    const maxSlip = Math.max(...v.tires.map((ty) => ty.combinedSlip));
    this.sound.update(dt.rpm, v.appliedThrottle, maxSlip, v.speed, dt.rpm >= this.car.maxRpm * 0.995);

    this.telemetryTimer -= frameDt;
    if (this.telemetryTimer <= 0 && this.hud.telemetry.classList.contains('show')) {
      this.telemetryTimer = 0.1;
      this.hud.telemetry.textContent = this.telemetryText();
    }
    this.debug.update();
    this.renderer.render();
  }

  private telemetryText(): string {
    const v = this.vehicle;
    const col = (vals: (string | number)[]) => vals.map((x) => String(x).padStart(8)).join('');
    const t = v.tires;
    const g = 9.81;
    return [
      `${''.padEnd(14)}${col(['ANT SX', 'ANT DX', 'POST SX', 'POST DX'])}`,
      `${'Carico (N)'.padEnd(14)}${col(t.map((x) => x.load.toFixed(0)))}`,
      `${'Slip long. %'.padEnd(14)}${col(t.map((x) => (x.kappa * 100).toFixed(1)))}`,
      `${'Deriva (°)'.padEnd(14)}${col(t.map((x) => ((Math.atan(x.tanAlpha) * 180) / Math.PI).toFixed(1)))}`,
      `${'Al limite'.padEnd(14)}${col(t.map((x) => (x.combinedSlip * 100).toFixed(0) + '%'))}`,
      `${'Superficie'.padEnd(14)}${col(v.surfaces.map((s) => s.name))}`,
      `${'T sup. °C'.padEnd(14)}${col(t.map((x) => x.surfaceTemp.toFixed(0)))}`,
      `${'T carcassa °C'.padEnd(14)}${col(t.map((x) => x.coreTemp.toFixed(0)))}`,
      `${'Pressione bar'.padEnd(14)}${col(t.map((x) => x.pressure.toFixed(2)))}`,
      `${'Battistrada %'.padEnd(14)}${col(t.map((x) => (x.tread * 100).toFixed(1)))}`,
      `${'Aderenza %'.padEnd(14)}${col(t.map((x) => (x.gripFactor * 100).toFixed(1)))}`,
      `${'Compress. mm'.padEnd(14)}${col(v.suspension.compression.map((c) => (c * 1000).toFixed(1)))}`,
      ``,
      `Acc. long ${(v.aLongSmooth / g).toFixed(2)} g   lat ${(v.aLatSmooth / g).toFixed(2)} g`,
      `Beccheggio ${((v.suspension.pitch * 180) / Math.PI).toFixed(2)}°   rollio ${((v.suspension.roll * 180) / Math.PI).toFixed(2)}°`,
      `Differenziale: trasferisce ${v.drivetrain.diffTransfer.toFixed(0)} Nm`,
      `Imbardata ${((v.yawRate * 180) / Math.PI).toFixed(1)} °/s   v.lat ${v.vLat.toFixed(2)} m/s`,
      `Coppia motore ${v.drivetrain.engineTorque.toFixed(0)} Nm${v.drivetrain.clutchSlipping ? '  (frizione)' : ''}`,
      `Pista s ${this.carS.toFixed(0)} / ${this.track.length.toFixed(0)} m   d ${this.carD.toFixed(1)} m`,
    ].join('\n');
  }
}
