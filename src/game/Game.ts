/**
 * Il "regista": carica auto e pista, crea tutti i sistemi e li collega.
 *
 * In pista ci sono più AUTO (entità): il pilota e i bot. Ogni auto ha
 * fisica (Vehicle), grafica (CarView), cronometraggio (Competitor) e,
 * se è un bot, un pilota artificiale (BotDriver). Pilota e bot usano
 * esattamente lo stesso codice di fisica.
 *
 * Gestisce le SESSIONI (prove libere, qualifica, gara): partenze, griglia,
 * record personali, fantasma, risultati.
 */
import { BotDriver, type Difficulty, type Traffic } from '../ai/BotDriver';
import { RacingLine } from '../ai/RacingLine';
import { makeRoster } from '../ai/roster';
import { EngineSound } from '../audio/EngineSound';
import { GameLoop } from '../core/GameLoop';
import { formatLapTime, MS_TO_KMH } from '../core/math';
import { loadJSON, saveJSON } from '../core/storage';
import { emptyInput, InputManager, type DriverInput } from '../input/InputManager';
import { listCars, loadCar, type CarEntry, type CarParams } from '../physics/CarParams';
import { resolveCollisions } from '../physics/Collisions';
import { Vehicle, type DrivingAids, type GroundContact, type Surface } from '../physics/Vehicle';
import { GhostPlayer, GhostRecorder } from '../race/Ghost';
import { ReplayPlayer, ReplayRecorder } from '../race/Replay';
import type { LapRecord, TimingEvent } from '../race/LapTiming';
import { Competitor, Session, SESSION_NAMES, type SessionConfig, type SessionEvent } from '../race/Session';
import { cloneRig, loadCarRig, type CarRig } from '../render/AssetManager';
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
import { loadSettings, openSettings, type GameSettings } from '../ui/Settings';
import { PitController, serviceTime, type PitPlan } from '../strategy/PitController';
import { activeAeroZones, ERS_MODE_NAMES, ERS_MODES } from '../physics/Hybrid';
import { applySetup, loadSetup, saveSetup, type SetupValues } from '../strategy/Setup';
import type { PitStall } from '../track/TrackSpline';

const DEFAULT_CAR = 'gt_segnaposto';

/** Superfici (Fase 7/8: valori diversi con pioggia, sporco, gomma depositata). */
const SURFACES: Record<Surface['name'], Surface> = {
  asfalto: { name: 'asfalto', grip: 1, drag: 0 },
  cordolo: { name: 'cordolo', grip: 0.93, drag: 0.005 },
  erba: { name: 'erba', grip: 0.55, drag: 0.06 },
};

const DEFAULT_AIDS: DrivingAids = { abs: true, tc: true, autoShift: true, keyboardSteerAssist: true };
/** I bot guidano come piloti GT veri: ABS, controllo di trazione e cambio automatico */
const BOT_AIDS: DrivingAids = { abs: true, tc: true, autoShift: true, keyboardSteerAssist: false };
/** Durante un errore di "bloccaggio" il bot frena senza ABS */
const BOT_AIDS_NO_ABS: DrivingAids = { ...BOT_AIDS, abs: false };
/** Distanza (m) entro cui si sente la scia dell'auto davanti */
const DRAFT_RANGE = 40;
const DEFAULT_SIM: SimSettings = { airTemp: 22, trackTemp: 32, wearMultiplier: 1, tyreBlankets: false };
const DEFAULT_SESSION: SessionConfig = {
  type: 'libere', minutes: 0, laps: 5, opponents: 9, difficulty: 'medio', grid: 'meta', wearMultiplier: 1, fuelMultiplier: 1,
};
/** Stima iniziale del consumo (kg per km a moltiplicatore 1), poi si misura giro per giro */
const FUEL_PER_KM_EST = 0.36; // misurato: ~0,76 kg/giro sui 2,2 km dell'Anello
/** Temperatura delle gomme montate con le termocoperte (°C) */
const BLANKET_TEMP = 80;

const fmtClock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** Un'auto in pista (pilota o bot). */
interface CarEntity {
  id: string;
  name: string;
  isPlayer: boolean;
  vehicle: Vehicle;
  view: CarView;
  competitor: Competitor;
  bot: BotDriver | null;
  /** indici di ricerca veloce sulla pista e sulla corsia box */
  wheelHints: number[];
  pitHints: number[];
  hint: number;
  /** posizione sulla pista */
  s: number;
  d: number;
  /** punto di partenza (per la partenza anticipata) */
  startX: number;
  startZ: number;
  /** corsia box: pilota automatico attivo, piazzola assegnata, sosta richiesta */
  pit: PitController | null;
  stall: PitStall | null;
  pitRequest: PitPlan | null;
  pitStops: number;
  /** carburante usato al passaggio sul traguardo e consumo medio al giro */
  fuelAtLine: number;
  fuelPerLap: number | null;
  /** mescole usate in gara (regola delle due mescole) e controllo all'arrivo già fatto */
  compoundsUsed: Set<string>;
  ruleChecked: boolean;
}

export class Game {
  private renderer!: Renderer;
  private input = new InputManager();
  private sound = new EngineSound();
  /** Motore dell'avversario più vicino (si sente in base alla distanza) */
  private opponentSound = new EngineSound();
  private settings: GameSettings = loadSettings();
  private fpsEl: HTMLDivElement | null = null;
  private fpsSmooth = 60;
  private aids: DrivingAids = loadJSON('aids', DEFAULT_AIDS);
  private sim: SimSettings = loadJSON('sim', DEFAULT_SIM);
  private sessionCfg: SessionConfig = loadJSON('session', DEFAULT_SESSION);
  private prefs = loadJSON('prefs', { ghost: true });
  private graph!: TelemetryGraph;
  private car!: CarParams;
  /** Copia "pulita" dell'auto per i bot (le regolazioni F2 valgono solo per te) */
  private botCar!: CarParams;
  /** Auto di fabbrica (dal file JSON), base per l'assetto */
  private baseCar!: CarParams;
  private setupValues!: SetupValues;
  /** Piano del prossimo pit stop del pilota */
  private pitPlan: PitPlan = { changeTyres: true, compound: 'media', addFuel: 0 };
  /** avvisi radio già dati in questa sessione (per non ripeterli) */
  private radioSaid = new Set<string>();
  /** Distanza sulla pista dell'ingresso box */
  private pitEntryS = 0;
  private playerRig!: CarRig;
  private track!: TrackSpline;
  private line!: RacingLine;
  private cameras!: CameraRig;
  private hud!: Hud;
  private overlay!: Overlay;
  private debug!: DebugPanel;
  private loop!: GameLoop;

  // ---- Auto in pista ----
  private entities: CarEntity[] = [];
  private playerEntity!: CarEntity;

  // ---- Sessione ----
  private session!: Session;
  private resultsTimer = 0;
  /** Ordine d'arrivo dell'ultima qualifica (id), per la griglia di gara */
  private lastQualiOrder: string[] | null = null;
  private contactCooldown = 0;
  /** Contatti tra auto (velocità d'urto > 2 m/s) dall'avvio: per statistiche e test */
  contactCount = 0;

  // ---- Record e fantasma ----
  private recordKey = '';
  private record: LapRecordData | null = null;
  /** Miglior settore di sempre (anche se il giro record è un altro) */
  private bestSectorsEver: (number | null)[] = [];
  private ghostRec = new GhostRecorder();
  /** Replay della sessione */
  private replayRec = new ReplayRecorder();
  private replayPlayer: ReplayPlayer | null = null;
  private ghost!: GhostPlayer;
  private sessionGhost: number[] | null = null;
  /** Settori del giro appena concluso, mostrati per qualche secondo nel giro nuovo */
  private lastLapShown: LapRecord | null = null;

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
  /** Campioni della pista in zona di aerodinamica attiva (1) */
  private aeroZones: Uint8Array = new Uint8Array(0);
  /** Auto disponibili e auto scelta (tutta la griglia usa la stessa: una sola classe) */
  private cars: CarEntry[] = [];
  private carId: string;

  constructor(private appEl: HTMLElement, private uiEl: HTMLElement, private trackId: string, private fromEditor = false, carId: string | null = null) {
    this.sessionCfg = { ...DEFAULT_SESSION, ...this.sessionCfg };
    this.carId = carId ?? loadJSON('car', DEFAULT_CAR);
  }

  // scorciatoie
  private get vehicle(): Vehicle {
    return this.playerEntity.vehicle;
  }
  private get player(): Competitor {
    return this.playerEntity.competitor;
  }

  async init(): Promise<void> {
    this.overlay = new Overlay(this.uiEl);
    this.renderer = new Renderer(this.appEl);

    // ---- Dati ----
    this.cars = await listCars();
    const entry = this.cars.find((c) => c.id === this.carId) ?? this.cars[0];
    this.carId = entry.id;
    saveJSON('car', this.carId);
    const [car, trackData] = await Promise.all([loadCar(`cars/${entry.file}`), TrackStore.load(this.trackId)]);
    this.car = car;
    this.input.carSteeringLockDeg = car.steeringLockDeg;
    // la monoposto ha un V6 turbo
    this.sound.cylinders = this.opponentSound.cylinders = car.body === 'monoposto' ? 6 : 8;

    // ---- Modello auto (GLB o segnaposto) ----
    const rig = await loadCarRig(car, '#d8231f');
    if (car.geometryFromModel && rig.source === 'glb' && rig.measured) {
      // Passo, carreggiate e raggio ruota letti dal tuo modello Blender
      Object.assign(car, rig.measured);
      console.info('[Game] Geometria letta dal modello:', rig.measured);
    }
    this.baseCar = structuredClone(car);
    this.botCar = structuredClone(car);
    // assetto salvato per questa pista (solo per la tua auto)
    this.setupValues = loadSetup(trackData.id, this.baseCar);
    applySetup(car, this.baseCar, this.setupValues);
    this.pitPlan.compound = car.setup.compound;
    this.playerRig = rig;
    this.ghost = new GhostPlayer(rig.root);
    this.renderer.scene.add(this.ghost.object);

    // ---- Pista e traiettoria ideale (per i bot) ----
    this.track = new TrackSpline(trackData);
    this.renderer.scene.add(buildTrackMesh(this.track, this.renderer.maxAnisotropy));
    this.line = new RacingLine(this.track);
    // zone di aerodinamica attiva (monoposto 2026): rettilinei lunghi
    this.aeroZones = activeAeroZones(this.track, car);
    this.line.aeroZones = this.aeroZones;
    if (this.track.pit) this.pitEntryS = this.track.project(this.track.pit.samples[0].x, this.track.pit.samples[0].z).s;

    // ---- Record personale (legato alla geometria: se modifichi la pista riparte da zero) ----
    this.recordKey = RecordStore.key(`${trackData.id}_${geometryHash(trackData)}`, car.id);
    try {
      this.record = (await RecordStore.load(this.recordKey)) ?? null;
    } catch (e) {
      console.warn('Record non disponibili:', e);
    }
    this.bestSectorsEver = this.record ? [...this.record.bestSectors] : [];

    // ---- Auto del pilota ----
    this.playerEntity = this.createEntity('pilota', 'Tu', true, car, rig);
    this.renderer.scene.add(rig.root);

    // ---- HUD e pannelli ----
    this.cameras = new CameraRig(this.renderer.camera, this.playerEntity.view);
    this.hud = new Hud(this.uiEl);
    this.graph = new TelemetryGraph(this.uiEl);
    this.debug = new DebugPanel(car, this.aids, this.sim, {
      onAidsChange: () => saveJSON('aids', this.aids),
      onSimChange: () => {
        saveJSON('sim', this.sim);
        this.applySim();
      },
      onNewTyres: () => {
        this.fitNewTyres(this.vehicle);
        this.hud.message(`Gomme nuove: ${this.vehicle.tires[0].compound.name}`, 2);
      },
      onCalibrateWheel: () => void this.openWheelCalibration(),
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

  /** Crea un'auto (fisica + grafica). Il cronometraggio viene creato a ogni sessione. */
  private createEntity(id: string, name: string, isPlayer: boolean, car: CarParams, rig: CarRig): CarEntity {
    const e = {
      id, name, isPlayer, bot: null,
      wheelHints: [-1, -1, -1, -1], pitHints: [-1, -1, -1, -1], hint: -1, s: 0, d: 0, startX: 0, startZ: 0,
      pit: null, stall: null, pitRequest: null, pitStops: 0, fuelAtLine: 0, fuelPerLap: null,
      compoundsUsed: new Set<string>(), ruleChecked: false,
    } as unknown as CarEntity;
    e.vehicle = new Vehicle(car, (i, x, z) => this.groundAt(e, i, x, z));
    e.view = new CarView(rig, e.vehicle);
    this.applySimTo(e.vehicle);
    return e;
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
      this.lastQualiOrder !== null,
      (cfg) => {
        this.started = true;
        this.sound.start();
        this.sound.setPaused(false);
        this.opponentSound.start();
        this.opponentSound.setPaused(false);
        this.applySettings();
        this.startSession(cfg);
      },
      () => void this.openWheelCalibration(),
      () => void this.openSetup(),
      this.cars, this.carId,
      (id) => {
        // cambiare auto ricarica la schermata di guida (modelli, fisica e bot nuovi)
        saveJSON('car', id);
        navigate('guida', { pista: this.trackId, auto: id, ...(this.fromEditor ? { da: 'editor' } : {}) });
      },
    );
  }

  /** Prepara e avvia una sessione. */
  startSession(cfg: SessionConfig, run = true): void {
    this.sessionCfg = { ...cfg };
    saveJSON('session', this.sessionCfg);
    this.session = new Session(this.sessionCfg, this.track.length, (e) => this.onSessionEvent(e));

    // ---- Auto: il pilota + i bot di questa sessione ----
    for (const e of this.entities) if (!e.isPlayer) this.renderer.scene.remove(e.view.rig.root);
    this.entities = [this.playerEntity];
    const roster = makeRoster(cfg.opponents, cfg.difficulty as Difficulty);
    for (const b of roster) {
      const rig = cloneRig(this.playerRig, b.color, parseInt(b.id.replace('bot_', '')) + 2);
      const e = this.createEntity(b.id, b.name, false, this.botCar, rig);
      e.bot = new BotDriver(this.line, e.vehicle, b.skill);
      this.renderer.scene.add(rig.root);
      this.entities.push(e);
    }
    for (const e of this.entities) {
      e.competitor = new Competitor(e.id, e.name, e.isPlayer, this.track.length, this.track.sectorS, (c, ev) => this.onTimingEvent(c, ev));
      this.session.add(e.competitor);
      this.fitNewTyres(e.vehicle);
    }
    this.prepareStrategy();

    this.sessionGhost = null;
    this.lastLapShown = null;
    this.resultsTimer = 0;
    this.ghostRec.restart();
    this.replayRec.reset();
    this.placeForSession();

    this.hud?.showLapList(null);
    this.hud?.clearMessage();
    this.lapListOn = false;
    if (run) {
      this.overlay.hide();
      this.loop.paused = false;
      this.hud.message(this.session.isRace ? 'Gara: attendi lo spegnimento dei semafori' : `${this.session.name}: buon lavoro!`, 3);
    }
  }

  /** Posiziona tutte le auto per l'inizio della sessione. */
  private placeForSession(): void {
    const bots = this.entities.filter((e) => !e.isPlayer);
    if (this.session.isRace) {
      // ordine di griglia
      let order: CarEntity[];
      const bySkill = [...bots].sort((a, b) => b.bot!.skill.grip - a.bot!.skill.grip);
      const mode = this.sessionCfg.grid;
      if (mode === 'qualifica' && this.lastQualiOrder) {
        const pos = (e: CarEntity) => {
          const i = this.lastQualiOrder!.indexOf(e.id);
          return i < 0 ? 999 : i;
        };
        order = [...this.entities].sort((a, b) => pos(a) - pos(b));
      } else if (mode === 'pole') order = [this.playerEntity, ...bySkill];
      else if (mode === 'fondo') order = [...bySkill, this.playerEntity];
      else {
        const mid = Math.floor(bySkill.length / 2);
        order = [...bySkill.slice(0, mid), this.playerEntity, ...bySkill.slice(mid)];
      }
      order.forEach((e, k) => {
        // se i posti in griglia non bastano, le auto in più si mettono più indietro
        if (k < this.track.grid.length) {
          const g = this.track.grid[k];
          this.placeAt(e, g.x, g.z, g.heading);
        } else this.placeOnLine(e, this.track.length - 6 - k * 8);
      });
    } else {
      // prove/qualifica: tu ai box (se ci sono), i bot sparsi lungo la pista
      if (this.placeInPits(this.playerEntity)) {
        // si esce dai box con il pilota automatico (limitatore), poi guidi tu
        const pe = this.playerEntity;
        pe.pit = new PitController(this.track.pit!, pe.stall!, pe.vehicle, { changeTyres: false, compound: '', addFuel: 0 }, () => {}, 'uscita');
      } else this.placeOnTrack(this.playerEntity, this.track.length - 150);
      const L = this.track.length;
      bots.forEach((e, k) => this.placeOnLine(e, L * 0.12 + (k * L * 0.85) / Math.max(1, bots.length)));
    }
    for (const e of this.entities) {
      e.startX = e.vehicle.x;
      e.startZ = e.vehicle.z;
      e.competitor.timing.resetPosition();
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
        if (e.c.isPlayer) this.hud.message(`🏁 Traguardo! Posizione ${e.c.position}`, 3);
        break;
      case 'end':
        if (this.session.config.type === 'qualifica') this.lastQualiOrder = this.session.standings().map((c) => c.id);
        this.resultsTimer = 2.5; // risultati dopo qualche secondo
        break;
    }
  }

  private onTimingEvent(c: Competitor, e: TimingEvent): void {
    if (e.type === 'lineCrossed') {
      this.session.onLineCrossed(c);
      const ent = this.entities.find((x) => x.competitor === c);
      if (ent) this.onLapLine(ent);
    }
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
      actions.push({ label: '▶ Vai in gara', primary: true, act: () => this.startSession({ ...this.sessionCfg, type: 'gara', grid: 'qualifica' }) });
    }
    actions.push(
      { label: '↻ Ripeti sessione', primary: s.config.type !== 'qualifica', act: () => this.startSession(this.sessionCfg) },
      ...(this.replayRec.frames.length > 20 ? [{ label: '🎬 Replay', act: () => this.startReplay() }] : []),
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

  /** Ferma davanti alla propria piazzola dei box. */
  private placeInPits(e: CarEntity): boolean {
    if (!e.stall) return false;
    this.placeAt(e, e.stall.x, e.stall.z, e.stall.heading);
    return true;
  }

  // =====================================================================
  //  STRATEGIA: carburante, piazzole, pit stop, radio
  // =====================================================================

  /** Consumo stimato al giro (kg) per un'auto: misurato se disponibile, altrimenti stimato. */
  private fuelPerLapOf(e: CarEntity): number {
    return e.fuelPerLap ?? (this.track.length / 1000) * (e.vehicle.car.fuelPerKmEst ?? FUEL_PER_KM_EST) * this.sessionCfg.fuelMultiplier;
  }

  /** Inizio sessione: moltiplicatori, piazzole, carburante (i bot decidono quanto caricarne). */
  private prepareStrategy(): void {
    const cfg = this.sessionCfg;
    const pit = this.track.pit;
    // piazzole: il pilota quella più vicina all'uscita, poi i bot
    const stalls = pit ? [...pit.stalls].sort((a, b) => b.s - a.s) : [];
    this.entities.forEach((e, k) => {
      e.vehicle.env.wearMultiplier = cfg.wearMultiplier;
      e.vehicle.env.fuelMultiplier = cfg.fuelMultiplier;
      e.stall = stalls.length ? stalls[k % stalls.length] : null;
      e.pit = null;
      e.pitRequest = null;
      e.pitStops = 0;
      e.compoundsUsed = new Set([e.vehicle.tires[0].compound.name]);
      e.ruleChecked = false;
      e.vehicle.hybrid.newLap(false);
      e.vehicle.fuelUsed = 0;
      e.fuelAtLine = 0;
      e.fuelPerLap = null;
      e.vehicle.speedLimiter = 0;
      const cap = e.vehicle.car.fuelCapacity;
      if (e.isPlayer) e.vehicle.fuel = Math.min(cap, e.vehicle.car.fuelKg);
      else if (this.session.isRace) {
        // il bot carica la benzina per tutta la gara più un margine (se ci sta nel serbatoio)
        const margin = e.vehicle.car.pit?.refuel === false ? 0.7 : 1.3;
        e.vehicle.fuel = Math.min(cap, (cfg.laps + margin) * this.fuelPerLapOf(e));
      } else e.vehicle.fuel = Math.min(cap, e.vehicle.car.fuelKg);
    });
    this.radioSaid.clear();
    this.pitPlan.compound = this.car.setup.compound;
  }

  /** Il pilota è entrato nella corsia box? (all'inizio della corsia, uscendo dalla pista) */
  private detectPitEntry(e: CarEntity): boolean {
    const pit = this.track.pit;
    if (!pit || !e.stall || this.session.state === 'semaforo') return false;
    const q = pit.project(e.vehicle.x, e.vehicle.z);
    if (q.s < 0 || q.s > Math.min(pit.limiterStart, 60) || Math.abs(q.d) > pit.data.width / 2) return false;
    // deve andare nel verso della corsia e trovarsi fuori dalla carreggiata della pista
    const smp = pit.atS(q.s);
    const dir = Math.sin(e.vehicle.yaw) * smp.tx + Math.cos(e.vehicle.yaw) * smp.tz;
    const halfTrack = this.track.at(e.hint).width / 2;
    return dir > 0.6 && Math.abs(e.d) > halfTrack - 0.5;
  }

  /** Avvia il pilota automatico dei box per un'auto con il suo piano di sosta. */
  private startPit(e: CarEntity, plan: PitPlan): void {
    e.pit = new PitController(this.track.pit!, e.stall!, e.vehicle, plan, (p) => this.doService(e, p));
    e.pitRequest = null;
    if (e.isPlayer) {
      const parts = [
        plan.changeTyres ? `gomme ${this.car.tire.compounds[plan.compound]?.name ?? plan.compound}` : 'niente gomme',
        plan.addFuel > 0 ? `+${plan.addFuel.toFixed(0)} kg di benzina` : 'niente benzina',
      ];
      if (this.car.pit?.refuel === false) parts.pop();
      this.radio(`Box, box! Piano: ${parts.join(', ')} · sosta ~${serviceTime(plan, this.car).toFixed(1)} s`);
    } else if (this.session.isRace) {
      this.radio(`${e.name} è entrato ai box.`, 4);
    }
  }

  /** Lavoro dei meccanici a fine sosta. */
  private doService(e: CarEntity, plan: PitPlan): void {
    const v = e.vehicle;
    if (v.car.pit?.refuel !== false) v.fuel = Math.min(v.car.fuelCapacity, v.fuel + plan.addFuel);
    if (plan.changeTyres) e.compoundsUsed.add(v.car.tire.compounds[plan.compound || v.car.setup.compound]?.name ?? '');
    if (plan.changeTyres) {
      const s = v.car.setup;
      const start = this.sim.tyreBlankets ? BLANKET_TEMP : this.sim.airTemp + 3;
      v.fitTyres(plan.compound || s.compound, s.pressureFront, s.pressureRear, start);
    }
    e.pitStops++;
    if (e.isPlayer) {
      this.radio("Via, via, via! Attento all'uscita dei box.", 3);
      this.pitPlan.addFuel = 0;
    }
  }

  /** Al passaggio sul traguardo: consumo medio, strategia dei bot, radio per il pilota. */
  private onLapLine(e: CarEntity): void {
    this.lapLineHybrid(e);
    this.checkCompoundRule(e);
    const used = e.vehicle.fuelUsed - e.fuelAtLine;
    e.fuelAtLine = e.vehicle.fuelUsed;
    if (used > 0.05 && !e.pit) e.fuelPerLap = e.fuelPerLap === null ? used : e.fuelPerLap * 0.6 + used * 0.4;
    const s = this.session;
    const lapsLeft = s.isRace ? s.config.laps - e.competitor.lapsDone : 99;
    if (!e.isPlayer) {
      if (!s.isRace || !this.track.pit || e.pit || e.pitRequest || lapsLeft <= 0) return;
      const perLap = this.fuelPerLapOf(e);
      const tread = Math.min(...e.vehicle.tires.map((t) => t.tread));
      // l'ingresso box è a fine giro: la sosta va chiesta finché la benzina basta per arrivarci con margine
      const canRefuel = e.vehicle.car.pit?.refuel !== false;
      const lowFuel = canRefuel && e.vehicle.fuel < (lapsLeft + 0.25) * perLap;
      const wornOut = tread < 0.28 && lapsLeft > 2;
      // regola delle due mescole: almeno una sosta, entro il 60% della gara
      const ruleStop = this.compoundRuleActive() && e.compoundsUsed.size < 2 && lapsLeft >= 1
        && (lapsLeft <= Math.max(1, Math.round(s.config.laps * 0.4)) || tread < 0.45);
      if (lowFuel || wornOut || ruleStop) {
        const cur = e.vehicle.tires[0].compound.name;
        const comps = e.vehicle.car.tire.compounds;
        // una mescola diversa da quella montata: la più dura se mancano tanti giri
        const other = Object.keys(comps).filter((id) => comps[id].name !== cur);
        const pick = e.compoundsUsed.size < 2 && other.length
          ? (lapsLeft > s.config.laps * 0.5 ? other[other.length - 1] : other[0])
          : e.vehicle.car.setup.compound;
        e.pitRequest = {
          changeTyres: tread < 0.6 || ruleStop,
          compound: pick,
          addFuel: Math.max(0, Math.min(e.vehicle.car.fuelCapacity, (lapsLeft + 1) * perLap) - e.vehicle.fuel),
        };
      }
      return;
    }
    this.playerRadioLap(e, lapsLeft);
  }

  /** La regola delle due mescole vale per la monoposto, in gare da almeno 5 giri con la corsia box. */
  private compoundRuleActive(): boolean {
    return !!this.car.rules?.twoCompounds && this.session.isRace && this.session.config.laps >= 5 && !!this.track.pit;
  }

  /** All'arrivo: chi non ha usato due mescole viene squalificato. */
  private checkCompoundRule(e: CarEntity): void {
    if (!e.competitor.finished || e.ruleChecked) return;
    e.ruleChecked = true;
    if (this.compoundRuleActive() && e.compoundsUsed.size < 2) {
      e.competitor.dsq = 'una sola mescola';
      if (e.isPlayer) this.radio('<b>Squalificato: in gara bisogna usare almeno due mescole diverse.</b>', 8);
    }
  }

  /**
   * Traguardo: nuovo giro per il sistema ibrido. OVERTAKE MODE: in gara, chi passa
   * sul traguardo entro 1 s dall'auto che lo precede può usarlo nel giro seguente.
   */
  private lapLineHybrid(e: CarEntity): void {
    const h = e.vehicle.hybrid;
    if (!h.hasErs) return;
    let earned = false;
    const s = this.session;
    if (s.isRace && s.state === 'corsa' && e.competitor.lapsDone >= 1) {
      const st = s.standings();
      const i = st.indexOf(e.competitor);
      const ahead = i > 0 ? st[i - 1] : null;
      if (ahead) {
        const t = ahead.timing.timeAtDistance(e.competitor.timing.totalDistance);
        earned = t !== null && e.competitor.timing.sessionTime - t < 1.0;
      }
    }
    h.newLap(earned);
    if (earned && !e.isPlayer) h.toggleOvertake(); // i bot lo usano subito
  }

  /** Comunicazioni dal box al pilota a ogni giro. */
  private playerRadioLap(e: CarEntity, lapsLeft: number): void {
    const s = this.session;
    const v = e.vehicle;
    const perLap = this.fuelPerLapOf(e);
    const fuelLaps = v.fuel / perLap;
    const tread = Math.min(...v.tires.map((t) => t.tread));
    const msgs: string[] = [];
    if (s.isRace && s.state === 'corsa') {
      const st = s.standings();
      const i = st.indexOf(e.competitor);
      const ahead = i > 0 ? st[i - 1] : null;
      const behind = i < st.length - 1 ? st[i + 1] : null;
      let gaps = `P${i + 1}`;
      if (ahead) {
        const t = ahead.timing.timeAtDistance(e.competitor.timing.totalDistance);
        if (t !== null) gaps += ` · davanti ${ahead.name} a ${(e.competitor.timing.sessionTime - t).toFixed(1)} s`;
      }
      if (behind) {
        const t = e.competitor.timing.timeAtDistance(behind.timing.totalDistance);
        if (t !== null) gaps += ` · dietro ${behind.name} a ${(behind.timing.sessionTime - t).toFixed(1)} s`;
      }
      msgs.push(gaps);
      if (this.track.pit && fuelLaps < lapsLeft - 0.2) {
        const need = Math.max(0, (lapsLeft + 0.5) * perLap - v.fuel);
        if (v.car.pit?.refuel === false) {
          msgs.push(`<b>Benzina per ${fuelLaps.toFixed(1)} giri, ne mancano ${lapsLeft}: risparmia (alza il piede prima delle frenate, modalità Ricarica)</b>`);
        } else {
          msgs.push(`<b>Benzina per ${fuelLaps.toFixed(1)} giri, ne mancano ${lapsLeft}: rientra e aggiungi ~${Math.ceil(need)} kg</b>`);
          this.pitPlan.addFuel = Math.max(this.pitPlan.addFuel, Math.ceil(need));
        }
      }
      if (this.compoundRuleActive() && e.compoundsUsed.size < 2 && lapsLeft > 0) {
        msgs.push('Regola: devi ancora montare una seconda mescola (pit stop; piano in pausa → 🛞 Strategia box).');
      }
      if (v.hybrid.overtakeAvailable) msgs.push('<b>Overtake mode disponibile: premi O</b>');
    }
    if (tread < 0.3 && !this.radioSaid.has('gomme30')) {
      this.radioSaid.add('gomme30');
      msgs.push('<b>Gomme quasi finite (sotto il 30%): valuta il pit stop.</b>');
    } else if (tread < 0.55 && !this.radioSaid.has('gomme55')) {
      this.radioSaid.add('gomme55');
      msgs.push('Gomme a metà vita.');
    }
    if (!s.isRace || s.state !== 'corsa') msgs.push(`Benzina: ${v.fuel.toFixed(1)} kg (~${Math.floor(fuelLaps)} giri)`);
    if (msgs.length) this.radio(msgs.join('<br>'), 6);
  }

  /** Messaggio radio del box (in basso a sinistra). */
  private radio(html: string, seconds = 5): void {
    this.hud?.radio(`<b>📻 Box:</b> ${html}`, seconds);
  }

  /** Apre il menu assetto. */
  private async openSetup(): Promise<void> {
    const wasPaused = this.loop.paused;
    this.loop.paused = true;
    const { SetupMenu } = await import('../strategy/SetupMenu');
    new SetupMenu(this.car, this.baseCar, this.setupValues, this.playerEntity?.fuelPerLap ?? null, (s) => {
      this.setupValues = s;
      applySetup(this.car, this.baseCar, s);
      saveSetup(this.track.data.id, this.car.id, s);
      this.pitPlan.compound = s.compound;
      this.hud?.message('Assetto salvato. Gomme e benzina dalla prossima partenza o sosta.', 3);
    }, () => { this.loop.paused = wasPaused; }).open();
  }

  /** Piano del prossimo pit stop (dal menu di pausa). */
  private openPitPlan(): void {
    const plan = this.pitPlan;
    const compounds = Object.entries(this.car.tire.compounds);
    const html = `
      <p>Il pit stop parte entrando nella corsia box: il resto lo fa la squadra.</p>
      <div class="form">
        <label><input type="checkbox" data-p="tyres" ${plan.changeTyres ? 'checked' : ''}> Cambia le gomme</label>
        <label>Mescola <select data-p="compound">${compounds.map(([id, c]) => `<option value="${id}" ${plan.compound === id ? 'selected' : ''}>${c.name}</option>`).join('')}</select></label>
        ${this.car.pit?.refuel === false
          ? '<p class="small">Niente rifornimento in questa categoria: la benzina deve bastare per tutta la gara.</p>'
          : `<label>Benzina da aggiungere (kg) <input type="number" min="0" max="${this.car.fuelCapacity}" step="1" value="${plan.addFuel}" data-p="fuel"></label>`}
        <p class="small">A bordo: ${this.vehicle.fuel.toFixed(1)} kg · consumo ~${this.fuelPerLapOf(this.playerEntity).toFixed(2)} kg/giro · durata sosta stimata ~${serviceTime(plan, this.car).toFixed(1)} s</p>
        ${this.compoundRuleActive() ? `<p class="small">Regola: in gara servono due mescole diverse. Usate finora: ${[...this.playerEntity.compoundsUsed].join(', ')}.</p>` : ''}
      </div>`;
    this.overlay.showResults('🛞 Strategia box', html, [{ label: 'OK, riprendi', primary: true, act: () => this.togglePause() }]);
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-p]').forEach((el) =>
      el.addEventListener('change', () => {
        if (el.dataset.p === 'tyres') plan.changeTyres = (el as HTMLInputElement).checked;
        else if (el.dataset.p === 'compound') plan.compound = el.value;
        else plan.addFuel = Math.max(0, Math.min(this.car.fuelCapacity, parseFloat(el.value) || 0));
      }),
    );
  }


  /** Ferma sulla linea centrale alla distanza s. */
  private placeOnTrack(e: CarEntity, s: number): void {
    const smp = this.track.atS(s);
    this.placeAt(e, smp.x, smp.z, smp.heading);
  }

  /** Ferma sulla traiettoria ideale alla distanza s (per i bot). */
  private placeOnLine(e: CarEntity, s: number): void {
    const L = this.track.length, n = this.line.n;
    const i = Math.round((((s % L) + L) % L) / (L / n)) % n;
    const smp = this.track.samples[i];
    this.placeAt(e, this.line.x[i], this.line.z[i], smp.heading);
  }

  private placeAt(e: CarEntity, x: number, z: number, heading: number): void {
    e.vehicle.reset(x, z, heading);
    const p = this.track.project(x, z);
    e.wheelHints = [p.index, p.index, p.index, p.index];
    e.pitHints = [-1, -1, -1, -1];
    e.hint = p.index;
    e.s = p.s;
    e.d = p.d;
  }

  /** Rimette in pista (tasto R, o bot bloccato): il giro non vale più. */
  private resetToTrack(e: CarEntity): void {
    if (e.isPlayer) this.placeOnTrack(e, e.s);
    else this.placeOnLine(e, e.s);
    e.competitor.timing.invalidate('auto riposizionata');
    e.competitor.timing.resetPosition();
  }

  // =====================================================================
  //  FISICA E AMBIENTE
  // =====================================================================

  private applySimTo(v: Vehicle): void {
    v.env.airTemp = this.sim.airTemp;
    v.env.trackTemp = this.sim.trackTemp;
    if (this.sessionCfg) {
      v.env.wearMultiplier = this.sessionCfg.wearMultiplier;
      v.env.fuelMultiplier = this.sessionCfg.fuelMultiplier;
    }
  }

  /** Condizioni ambientali → fisica delle gomme di tutte le auto. */
  private applySim(): void {
    for (const e of this.entities) this.applySimTo(e.vehicle);
    if (this.playerEntity) this.applySimTo(this.playerEntity.vehicle);
  }

  /** Monta gomme nuove secondo l'assetto (mescola e pressioni a freddo). */
  private fitNewTyres(v: Vehicle): void {
    const s = v.car.setup;
    const start = this.sim.tyreBlankets ? BLANKET_TEMP : this.sim.airTemp + 3;
    v.fitTyres(s.compound, s.pressureFront, s.pressureRear, start);
  }

  /**
   * Cosa c'è sotto una ruota: asfalto, cordolo o erba (dalla distanza dal centro pista)
   * e l'altezza del suolo: i cordoli sono rialzati e "a dente", l'erba è irregolare.
   */
  private groundAt(e: CarEntity, i: number, x: number, z: number): GroundContact {
    const p = this.track.project(x, z, e.wheelHints[i]);
    e.wheelHints[i] = p.index;
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
      const q = pit.project(x, z, e.pitHints[i]);
      e.pitHints[i] = q.index;
      if (q.s > -3 && q.s < pit.length + 3 && Math.abs(q.d) <= pit.data.width / 2) return { surface: SURFACES.asfalto, height: 0 };
    }
    const bumps = 0.012 * (Math.sin(p.s * 0.9) + Math.sin(p.d * 1.7 + p.s * 0.31)) * 0.5;
    return { surface: SURFACES.erba, height: bumps };
  }

  private fixedUpdate(dt: number): void {
    if (this.replayPlayer) return; // durante il replay la simulazione è ferma
    const finished = this.session.state === 'finita';
    const hold = this.session.state === 'semaforo';

    // ---- 0) chi vede cosa: traffico e scia ----
    const L = this.track.length;
    const traffic: Traffic[] = this.entities.map((e) => ({
      s: e.s, d: e.d, speed: e.vehicle.speed,
      total: e.competitor.timing.totalDistance,
      offTrack: e.vehicle.surfaces.filter((x) => x.name === 'erba').length >= 2,
    }));
    this.updateSlipstream(L);

    // ---- 1) comandi e fisica di ogni auto ----
    this.entities.forEach((e, k) => {
      let input: DriverInput;
      // ---- corsia box: ingresso (pilota o bot con sosta richiesta) e pilota automatico ----
      if (!e.pit && !finished && this.track.pit && e.stall) {
        if (e.isPlayer && this.detectPitEntry(e)) this.startPit(e, { ...this.pitPlan });
        else if (!e.isPlayer && e.pitRequest) {
          let toEntry = this.pitEntryS - e.s;
          if (toEntry < 0) toEntry += L;
          if (toEntry < 45) this.startPit(e, e.pitRequest);
        }
      }
      const pitInput = e.pit ? e.pit.drive(dt) : null;
      if (e.pit && !pitInput) e.pit = null;
      if (pitInput) {
        input = pitInput;
        if (e.isPlayer) {
          this.input.read(dt, e.vehicle.speed, false); // consuma i comandi (la squadra guida per te)
          this.lastSteer = input.steer;
        }
      } else if (e.isPlayer) {
        // a sessione finita il pilota non guida più (l'auto rallenta da sola)
        input = finished ? { ...emptyInput(), brake: 0.3 } : this.input.read(dt, e.vehicle.speed, this.aids.keyboardSteerAssist);
        this.lastSteer = input.steer;
      } else {
        const others = traffic.filter((_, j) => j !== k);
        const cmd = e.bot!.drive(dt, e.s, e.d, e.competitor.timing.totalDistance, others, hold);
        // i bot che hanno finito proseguono piano (giro di rientro)
        input = e.competitor.finished || finished ? { ...cmd, throttle: Math.min(cmd.throttle, 0.25) } : cmd;
      }
      const aids = e.isPlayer ? this.aids : e.bot!.absOff ? BOT_AIDS_NO_ABS : BOT_AIDS;
      e.vehicle.step(dt, input, aids);
    });
    this.updateFlags(traffic, L);

    // ---- 2) collisioni ----
    const hits = resolveCollisions(this.entities.map((e) => e.vehicle));
    this.contactCooldown -= dt;
    for (const h of hits) {
      if (h.speed > 2) this.contactCount++;
      if ((h.a === this.vehicle || h.b === this.vehicle) && h.speed > 2 && this.contactCooldown <= 0) {
        this.hud.message('Contatto!', 1);
        this.contactCooldown = 1;
      }
    }

    // ---- 3) posizione in pista, cronometraggio, sicurezza ----
    for (const e of this.entities) {
      const p = this.track.project(e.vehicle.x, e.vehicle.z, e.hint);
      e.hint = p.index;
      e.s = p.s;
      e.d = p.d;
      e.vehicle.hybrid.inAeroZone = this.aeroZones[p.index] === 1 && !e.pit;
      const allOff = e.vehicle.surfaces.every((s) => s.name === 'erba');
      if (!e.competitor.finished) e.competitor.timing.update(dt, p.s, allOff);
      if (e.isPlayer) {
        if (Math.abs(p.d) > 120) this.resetToTrack(e); // rete di sicurezza
      } else if (e.competitor.retired) {
        // ritirato: resta dov'è
      } else if (e.vehicle.fuel <= 0 && e.vehicle.speed < 1) {
        e.competitor.retired = true;
        if (this.session.isRace) this.radio(`${e.name} si è ritirato: senza benzina.`, 4);
      } else if (!hold && !e.pit && (Math.abs(p.d) > 35 || e.bot!.stuckTime > 4)) {
        // bot finito lontano o bloccato: torna in pista
        this.resetToTrack(e);
        e.bot!.stuckTime = 0;
      }
    }
    const t = this.player.timing;
    if (t.lap > 0) this.ghostRec.sample(t.current, this.vehicle.x, this.vehicle.z, this.vehicle.yaw);

    if (this.session.state !== 'finita') this.replayRec.record(dt, this.entities);
    const byComp = new Map(this.entities.map((e) => [e.competitor, e]));
    this.session.update(dt, (c) => {
      const e = byComp.get(c)!;
      return Math.hypot(e.vehicle.x - e.startX, e.vehicle.z - e.startZ);
    });
  }

  /**
   * SCIA: chi segue da vicino un'altra auto (stessa linea, entro 40 m) ha meno
   * resistenza dell'aria ma anche meno deportanza. Effetto massimo a pochi metri.
   */
  private updateSlipstream(L: number): void {
    for (const e of this.entities) {
      let f = 0;
      for (const o of this.entities) {
        if (o === e) continue;
        let gap = o.s - e.s;
        if (gap < -L / 2) gap += L;
        if (gap > L / 2) gap -= L;
        if (gap > 3 && gap < DRAFT_RANGE && Math.abs(o.d - e.d) < 2.2) f = Math.max(f, 1 - gap / DRAFT_RANGE);
      }
      e.vehicle.dragFactor = 1 - 0.35 * f;
      e.vehicle.downforceFactor = 1 - 0.3 * f;
    }
  }

  /** Bandiere per il pilota: gialla (auto ferma/fuori più avanti), blu (arriva chi ti doppia). */
  private flags = { yellow: false, blue: false };
  private updateFlags(traffic: Traffic[], L: number): void {
    const me = this.playerEntity;
    const myTotal = me.competitor.timing.totalDistance;
    let yellow = false, blue = false;
    traffic.forEach((o, j) => {
      if (this.entities[j] === me) return;
      let gap = o.s - me.s;
      if (gap < -L / 2) gap += L;
      if (gap > L / 2) gap -= L;
      if (gap > 0 && gap < 250 && (o.offTrack || o.speed < 8) && this.session.state === 'corsa') yellow = true;
      if (this.session.isRace && gap < 0 && gap > -70 && o.total > myTotal + L * 0.5) blue = true;
    });
    this.flags = { yellow, blue };
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
          if (this.session.state !== 'semaforo') this.resetToTrack(this.playerEntity);
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
        case 'overtake': {
          const h = this.vehicle.hybrid;
          if (!h.hasErs) break;
          if (h.toggleOvertake()) this.hud.message(h.overtakeActive ? '⚡ Overtake mode ATTIVO' : 'Overtake mode disattivato', 1.5);
          else this.hud.message('Overtake mode non disponibile: devi passare sul traguardo entro 1 s da chi ti precede', 2.5);
          break;
        }
        case 'ersMode': {
          const h = this.vehicle.hybrid;
          if (!h.hasErs) break;
          h.mode = ERS_MODES[(ERS_MODES.indexOf(h.mode) + 1) % ERS_MODES.length];
          this.hud.message(`🔋 Batteria: modalità ${ERS_MODE_NAMES[h.mode]}`, 1.5);
          break;
        }
      }
    }
  }

  private togglePause(show = true): void {
    if (this.loop.paused) {
      this.overlay.hide();
      this.loop.paused = false;
      this.sound.setPaused(false);
      this.opponentSound.setPaused(false);
    } else {
      this.loop.paused = true;
      this.sound.setPaused(true);
      this.opponentSound.setPaused(true);
      if (!show) return;
      this.overlay.showPause(() => this.togglePause(), [
        { label: '↻ Ricomincia sessione', act: () => this.startSession(this.sessionCfg) },
        { label: '🏁 Termina e vedi risultati', act: () => this.endSessionEarly() },
        { label: 'Cambia sessione…', act: () => this.showSessionChoice() },
        { label: '🔧 Assetto', act: () => void this.openSetup() },
        { label: '🛞 Strategia box', act: () => this.openPitPlan() },
        { label: '🎮 Calibra volante', act: () => void this.openWheelCalibration() },
        { label: '⚙ Impostazioni', act: () => openSettings(this.settings, () => this.applySettings()) },
        ...(this.fromEditor ? [{ label: "✎ Torna all'editor", act: () => navigate('editor', { pista: this.trackId }) }] : []),
        { label: 'Menu principale', act: () => navigate('menu') },
      ]);
    }
  }

  /** Avvia il replay della sessione appena conclusa. */
  private startReplay(): void {
    this.overlay.hide();
    this.sound.setPaused(true);
    this.opponentSound.setPaused(true);
    this.loop.paused = false;
    const cars = this.entities.map((e) => ({ name: e.name, vehicle: e.vehicle, view: e.view }));
    this.replayPlayer = new ReplayPlayer(this.replayRec, cars, this.cameras, this.renderer.camera, this.track, () => {
      this.replayPlayer = null;
      this.cameras.view = this.playerEntity.view;
      this.cameras.mode = 'esterna';
      this.showResults();
    }, 0);
  }

  /** Applica impostazioni grafiche e audio. */
  private applySettings(): void {
    const s = this.settings;
    this.renderer.applyQuality(s.quality);
    this.sound.setVolume(s.volume);
    if (s.showFps && !this.fpsEl) {
      this.fpsEl = document.createElement('div');
      this.fpsEl.className = 'hud-panel hud-fps mono';
      this.uiEl.appendChild(this.fpsEl);
    } else if (!s.showFps && this.fpsEl) {
      this.fpsEl.remove();
      this.fpsEl = null;
    }
  }

  /** Il motore dell'avversario più vicino: più forte quanto più è vicino (entro 90 m). */
  private updateOpponentSound(): void {
    const me = this.vehicle;
    let best: CarEntity | null = null, bd = 90;
    for (const e of this.entities) {
      if (e.isPlayer) continue;
      const d = Math.hypot(e.vehicle.x - me.x, e.vehicle.z - me.z);
      if (d < bd) { bd = d; best = e; }
    }
    const vol = best ? this.settings.volume * this.settings.opponentVolume * Math.pow(1 - bd / 90, 2) * 0.8 : 0;
    this.opponentSound.setVolume(vol);
    if (best) this.opponentSound.update(best.vehicle.drivetrain.rpm, best.vehicle.appliedThrottle, 0, 0, false);
  }

  /** Calibrazione guidata del volante (sopra qualsiasi schermata). */
  private async openWheelCalibration(): Promise<void> {
    const { WheelCalibration } = await import('../input/WheelCalibration');
    new WheelCalibration(this.input).open();
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
    else if (s.isRace) info = `Giro ${Math.min(Math.max(s.leader?.timing.lap ?? 1, 1), s.config.laps)}/${s.config.laps}`;
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
      delta: s.isRace ? null : t.deltaAt(this.playerEntity.s, ref.trace),
      deltaRef: ref.label,
      valid: t.valid,
      lastLap: t.laps.length ? t.laps[t.laps.length - 1].time : null,
      bestLap: t.best?.time ?? null,
      recordLap: this.record?.lapTime ?? null,
      sectors: secs.map((x, i) => ({ time: x, color: x === null ? '' : this.sectorColor(i, x, valid) })),
    };
  }

  private render(alpha: number, frameDt: number): void {
    if (this.replayPlayer) {
      this.replayPlayer.update(frameDt);
      this.renderer.followShadows(this.replayPlayer['cars'][this.replayPlayer.follow].view.position);
      this.renderer.render();
      return;
    }
    this.handleActions();
    const v = this.vehicle;
    for (const e of this.entities) e.view.update(alpha);
    this.cameras.update(frameDt, v.speed);
    this.renderer.followShadows(this.playerEntity.view.position);

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
      flag: this.flags.blue ? 'blu' : this.flags.yellow ? 'gialla' : null,
      fuel: v.fuel,
      fuelLaps: v.fuel / this.fuelPerLapOf(this.playerEntity),
      limiter: v.speedLimiter > 0,
      pit: this.playerEntity.pit ? { phase: this.playerEntity.pit.phase, left: this.playerEntity.pit.serviceLeft, total: this.playerEntity.pit.serviceTotal } : null,
      draft: this.vehicle.dragFactor < 0.93,
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
      ers: v.hybrid.hasErs ? {
        charge: v.hybrid.charge,
        powerKW: v.hybrid.power / 1000,
        mode: ERS_MODE_NAMES[v.hybrid.mode],
        overtake: v.hybrid.overtakeActive ? 'attivo' : v.hybrid.overtakeAvailable ? 'disponibile' : 'no',
        aeroOpen: v.hybrid.aeroOpen,
        aeroZone: v.hybrid.inAeroZone,
      } : null,
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

    this.updateOpponentSound();
    if (this.fpsEl && frameDt > 0) {
      this.fpsSmooth += (1 / frameDt - this.fpsSmooth) * 0.05;
      this.fpsEl.textContent = `${Math.round(this.fpsSmooth)} FPS`;
    }

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
    const pe = this.playerEntity;
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
      `Pista s ${pe.s.toFixed(0)} / ${this.track.length.toFixed(0)} m   d ${pe.d.toFixed(1)} m`,
    ].join('\n');
  }
}
