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
import { Minimap } from '../ui/Minimap';
import { RainFx } from '../render/RainFx';
import { RaceControl } from '../race/RaceControl';
import { BoxRadio, type RadioIntent, type RadioPrio } from './BoxRadio';
import { Weather, WEATHER_NAMES, idealTyreClass, tyreClassOf, wetGripFactor, type WeatherMode } from '../race/Weather';
import {
  CareerStore, PLAYER_ID, applyCarLevels, botSkillOf, failureChance, playerDriver, playerTeam, raceLaps,
  racingDrivers, recordRace, teamOf, teamStandings, driverStandings, ordinal, type Career,
} from '../career/CareerData';
import { FlashbackBuffer, restore, snapshot } from './Flashback';
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
import { activeAeroZones, ERS_MODE_NAMES } from '../physics/Hybrid';
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
  /** colore della livrea (minimappa) */
  color: string;
  /** indici di ricerca veloce sulla pista e sulla corsia box */
  wheelHints: number[];
  pitHints: number[];
  hint: number;
  /** posizione sulla pista */
  s: number;
  d: number;
  /** battistrada al passaggio sul traguardo e consumo medio al giro (per la strategia) */
  treadAtLine: number;
  treadPerLap: number | null;
  /** ritirata e portata via dai commissari: fuori dalla pista, invisibile, ignorata da tutti */
  parked: boolean;
  /** da quanto è ferma dopo il ritiro (s) */
  retireT: number;
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
  private minimap!: Minimap;
  /** MODALITÀ CARRIERA: dati della carriera (null = guida libera) */
  private career: Career | null = null;
  /** fase del weekend di carriera */
  private careerStage: 'libere' | 'qualifica' | 'gara' | 'fatto' = 'libere';
  private careerSaved = false;
  /** auto di base (senza livelli della scuderia né assetto): da qui si fanno le auto delle scuderie */
  private rawCar!: CarParams;
  /** ordine di partenza della gara (id) */
  private raceGrid: string[] = [];
  /** guasti in arrivo: distanza (m) a cui l'auto si rompe */
  private failAt = new Map<CarEntity, number>();
  /** Il pilota ha finito la gara: dopo un attimo si simula velocemente l'arrivo degli altri */
  private finishSim: { delay: number; started: boolean } | null = null;
  /** Flashback: fotografie degli ultimi secondi e stato della scelta (null = non attivo) */
  private flashback = new FlashbackBuffer();
  private fbClock = 0;
  private fb: { index: number; back: number; time: number; armed: boolean } | null = null;
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
  /** Radio del box: messaggi, voce, menu, microfono */
  private boxRadio!: BoxRadio;
  /** Il pilota ha chiamato "box questo giro" (il box ricorda di entrare prima della corsia) */
  private boxCall = false;
  private boxCallReminded = false;
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
  /** Ultimo urto che ha fatto danni, per coppia di auto (tempo fbClock) */
  private hitCooldown = new Map<string, number>();
  /** Meteo della sessione */
  private weather = new Weather('asciutto', 600);
  private weatherTimer = 0;
  /** Pioggia, cielo coperto, asfalto bagnato, spruzzi */
  private rainFx!: RainFx;
  /** Direzione gara: VSC, safety car, bandiera rossa */
  private rc = new RaceControl();
  /** La safety car (non è un concorrente) */
  private sc: CarEntity | null = null;
  private scPrevGap = 0;
  /** profilo di velocità di riferimento per il limite VSC */
  private vscProfile: Float32Array | null = null;
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

  constructor(private appEl: HTMLElement, private uiEl: HTMLElement, private trackId: string, private fromEditor = false, carId: string | null = null, private careerId: string | null = null) {
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
    if (this.careerId) {
      this.career = (await CareerStore.load(this.careerId)) ?? null;
      if (!this.career) throw new Error('Carriera non trovata (è stata eliminata?).');
      this.carId = this.career.carClass;
      this.careerStage = this.career.practiceMinutes > 0 ? 'libere' : 'qualifica';
    }
    const entry = this.cars.find((c) => c.id === this.carId) ?? this.cars[0];
    this.carId = entry.id;
    saveJSON('car', this.carId);
    const [car, trackData] = await Promise.all([loadCar(`cars/${entry.file}`), TrackStore.load(this.trackId)]);
    this.car = car;
    this.input.carSteeringLockDeg = car.steeringLockDeg;
    // la monoposto ha un V6 turbo
    this.sound.cylinders = this.opponentSound.cylinders = car.body === 'monoposto' ? 6 : 8;
    this.sound.maxRpm = this.opponentSound.maxRpm = car.maxRpm;

    // ---- Modello auto (GLB o segnaposto) ----
    const rig = this.career
      ? await loadCarRig(car, playerTeam(this.career).color, playerDriver(this.career).number)
      : await loadCarRig(car, '#d8231f');
    if (car.geometryFromModel && rig.source === 'glb' && rig.measured) {
      // Passo, carreggiate e raggio ruota letti dal tuo modello Blender
      Object.assign(car, rig.measured);
      console.info('[Game] Geometria letta dal modello:', rig.measured);
    }
    this.rawCar = structuredClone(car);
    // carriera: la tua auto ha i livelli (motore, aerodinamica, telaio) della tua scuderia
    if (this.career) applyCarLevels(car, playerTeam(this.career).car);
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
    const trackMesh = buildTrackMesh(this.track, this.renderer.maxAnisotropy);
    this.renderer.scene.add(trackMesh);
    this.rainFx = new RainFx(this.renderer.scene, this.renderer.sun, this.renderer.hemi, this.renderer.renderer, this.renderer.sky);
    this.rainFx.registerWet(trackMesh);
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
    this.playerEntity = this.createEntity('pilota', this.career ? playerDriver(this.career).name : 'Tu', true, car, rig);
    this.renderer.scene.add(rig.root);

    // ---- HUD e pannelli ----
    this.cameras = new CameraRig(this.renderer.camera, this.playerEntity.view);
    this.hud = new Hud(this.uiEl);
    this.boxRadio = new BoxRadio(
      this.uiEl,
      (i, spoken) => this.radioAnswer(i, spoken),
      () => Object.fromEntries(Object.entries(this.car.tire.compounds).map(([id, c]) => [id, c.name])),
      () => this.pitPlan.compound,
      { voice: this.settings.radioVoice, volume: this.settings.radioVolume * this.settings.volume * 2 },
    );
    this.graph = new TelemetryGraph(this.uiEl);
    this.minimap = new Minimap(this.track);
    this.uiEl.appendChild(this.minimap.el);
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
    if (this.career) this.showCareerWeekend();
    else this.showSessionChoice();
  }

  /** Crea un'auto (fisica + grafica). Il cronometraggio viene creato a ogni sessione. */
  private createEntity(id: string, name: string, isPlayer: boolean, car: CarParams, rig: CarRig): CarEntity {
    const e = {
      id, name, isPlayer, bot: null,
      wheelHints: [-1, -1, -1, -1], pitHints: [-1, -1, -1, -1], hint: -1, s: 0, d: 0, startX: 0, startZ: 0,
      pit: null, stall: null, pitRequest: null, pitStops: 0, fuelAtLine: 0, fuelPerLap: null,
      compoundsUsed: new Set<string>(), ruleChecked: false, parked: false, retireT: 0, treadAtLine: 1, treadPerLap: null,
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
    if (!this.career) saveJSON('session', this.sessionCfg);
    this.session = new Session(this.sessionCfg, this.track.length, (e) => this.onSessionEvent(e));
    // durata stimata della sessione (per distribuire gli scrosci)
    const dur = cfg.type === 'gara' ? cfg.laps * (this.track.length / 50) : cfg.minutes > 0 ? cfg.minutes * 60 : 1500;
    this.weather = new Weather(cfg.weather ?? 'asciutto', dur);
    this.rainFx?.clearSpray();
    this.rc.reset();
    this.removeSafetyCar();
    this.vscProfile = null;

    // ---- Auto: il pilota + i bot di questa sessione ----
    for (const e of this.entities) if (!e.isPlayer) this.renderer.scene.remove(e.view.rig.root);
    this.entities = [this.playerEntity];
    const roster = this.career
      ? this.careerRoster()
      : makeRoster(cfg.opponents, cfg.difficulty as Difficulty).map((b) => ({ ...b, number: parseInt(b.id.replace('bot_', '')) + 2, car: this.botCar }));
    for (const b of roster) {
      const rig = cloneRig(this.playerRig, b.color, b.number);
      const e = this.createEntity(b.id, b.name, false, b.car, rig);
      e.bot = new BotDriver(this.line, e.vehicle, b.skill);
      e.color = String(b.color);
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
    this.flashback.clear();
    this.fb = null;
    this.finishSim = null;
    this.failAt.clear();
    this.careerSaved = false;
    this.placeForSession();

    this.hud?.showLapList(null);
    this.hud?.clearMessage();
    this.lapListOn = false;
    if (run) {
      this.overlay.hide();
      this.loop.paused = false;
      // l'audio può essere in pausa (menu di pausa, risultati, replay): si riaccende
      if (this.started) {
        this.sound.setPaused(false);
        this.opponentSound.setPaused(false);
      }
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
      this.raceGrid = order.map((e) => e.id);
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
        if (this.career && this.session.isRace && !e.restart) this.planFailures();
        break;
      case 'jumpStart':
        if (e.c.isPlayer) this.hud.message('Partenza anticipata: +5 s di penalità', 4);
        break;
      case 'flag':
        this.hud.message(this.session.isRace ? '🏁 Bandiera a scacchi' : '🏁 Tempo scaduto: completa il giro', 4);
        break;
      case 'finished':
        if (e.c.isPlayer) {
          this.hud.message(`🏁 Traguardo! Posizione ${e.c.position}`, 3);
          // in gara non si aspetta che tutti finiscano l'ultimo giro: lo si simula (vedi finishRace)
          if (this.session.isRace) this.finishSim = { delay: 2.5, started: false };
        }
        break;
      case 'end':
        if (this.session.config.type === 'qualifica') this.lastQualiOrder = this.session.standings().map((c) => c.id);
        this.removeSafetyCar();
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
    if (this.career) return this.showCareerResults(html);
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
      e.vehicle.damage.reset();
      this.fitWeatherTyres(e, true);
      e.treadAtLine = Math.min(...e.vehicle.tires.map((t) => t.tread));
      e.treadPerLap = null;
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
    this.boxCall = false;
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
      this.boxCall = false;
      const parts = [
        plan.changeTyres ? `gomme ${this.car.tire.compounds[plan.compound]?.name ?? plan.compound}` : 'niente gomme',
        plan.addFuel > 0 ? `+${plan.addFuel.toFixed(0)} kg di benzina` : 'niente benzina',
      ];
      if (this.car.pit?.refuel === false) parts.pop();
      this.radio(`Box, box! Piano: ${parts.join(', ')} · sosta ~${serviceTime(plan, this.car).toFixed(1)} s`);
    } else if (this.session.isRace) {
      // solo chi lotta con te: chi ti precede o segue di una posizione
      const d = Math.abs(e.competitor.position - this.player.position);
      if (d === 1) this.radio(`${e.name} (P${e.competitor.position}) è entrato ai box.`, 4);
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
      e.treadAtLine = 1;
    }
    // gomme nuove: niente più forature; ala nuova se chiesta (i bot la chiedono da soli)
    if (plan.changeTyres) v.damage.puncture = [false, false, false, false];
    if (plan.repair) v.damage.repairWings();
    e.pitStops++;
    if (e.isPlayer) {
      this.radio("Via, via, via! Attento all'uscita dei box.", 3);
      this.pitPlan.addFuel = 0;
      this.pitPlan.repair = false;
    }
  }

  /** Al passaggio sul traguardo: consumo medio, strategia dei bot, radio per il pilota. */
  private onLapLine(e: CarEntity): void {
    this.rcLeaderLine(e);
    this.lapLineHybrid(e);
    this.checkCompoundRule(e);
    const used = e.vehicle.fuelUsed - e.fuelAtLine;
    e.fuelAtLine = e.vehicle.fuelUsed;
    if (used > 0.05 && !e.pit) e.fuelPerLap = e.fuelPerLap === null ? used : e.fuelPerLap * 0.6 + used * 0.4;
    const tread = Math.min(...e.vehicle.tires.map((t) => t.tread));
    const worn = e.treadAtLine - tread;
    if (worn > 0.001 && !e.pit) e.treadPerLap = e.treadPerLap === null ? worn : e.treadPerLap * 0.6 + worn * 0.4;
    e.treadAtLine = tread;
    const s = this.session;
    const lapsLeft = s.isRace ? s.config.laps - e.competitor.lapsDone : 99;
    if (!e.isPlayer) {
      // gomme sbagliate per il meteo: si rientra subito (anche in prova)
      if (this.track.pit && !e.pit && !e.pitRequest && lapsLeft > 0) {
        const want = this.weatherCompound(e.vehicle);
        if (want) {
          e.pitRequest = { changeTyres: true, compound: want, addFuel: 0, repair: e.vehicle.damage.frontWing > 0.2 };
          return;
        }
      }
      if (!s.isRace || !this.track.pit || e.pit || e.pitRequest || lapsLeft <= 0) return;
      const perLap = this.fuelPerLapOf(e);
      const tread = Math.min(...e.vehicle.tires.map((t) => t.tread));
      // l'ingresso box è a fine giro: la sosta va chiesta finché la benzina basta per arrivarci con margine
      const canRefuel = e.vehicle.car.pit?.refuel !== false;
      const lowFuel = canRefuel && e.vehicle.fuel < (lapsLeft + 0.25) * perLap;
      const wornOut = tread < 0.28 && lapsLeft > 2;
      // regola delle due mescole: almeno una sosta, entro il 60% della gara
      const ruleStop = this.compoundRuleActive() && !this.ruleOk(e) && lapsLeft >= 1
        && (lapsLeft <= Math.max(1, Math.round(s.config.laps * 0.4)) || tread < 0.45);
      if (lowFuel || wornOut || ruleStop) {
        const cur = e.vehicle.tires[0].compound.name;
        const comps = e.vehicle.car.tire.compounds;
        // una mescola diversa da quella montata: la più dura se mancano tanti giri
        const other = Object.keys(comps).filter((id) => comps[id].name !== cur && !comps[id].wet);
        const pick = this.weatherCompound(e.vehicle) ?? (!this.ruleOk(e) && other.length
          ? (lapsLeft > s.config.laps * 0.5 ? other[other.length - 1] : other[0])
          : this.compoundIdOf(e.vehicle));
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

  /** Regola delle mescole rispettata: due mescole diverse, oppure gomme da pioggia usate */
  private ruleOk(e: CarEntity): boolean {
    const comps = Object.values(e.vehicle.car.tire.compounds);
    return e.compoundsUsed.size >= 2 || [...e.compoundsUsed].some((n) => comps.find((c) => c.name === n)?.wet);
  }

  /** id della mescola montata */
  private compoundIdOf(v: Vehicle): string {
    const comps = v.car.tire.compounds;
    return Object.keys(comps).find((k) => comps[k].name === v.tires[0].compound.name) ?? v.car.setup.compound;
  }

  /**
   * Gomme giuste per il meteo: id della mescola da montare, oppure null se quelle montate vanno
   * bene. Slick → la mescola dell'assetto (o media).
   */
  private weatherCompound(v: Vehicle): string | null {
    const comps = v.car.tire.compounds;
    const cur = tyreClassOf(v.tires[0].compound);
    const want = idealTyreClass(this.weather.wetness, cur);
    if (want === cur) return null;
    if (want === 'slick') return comps[v.car.setup.compound]?.wet ? (Object.keys(comps).find((k) => !comps[k].wet) ?? null) : v.car.setup.compound;
    return Object.keys(comps).find((k) => tyreClassOf(comps[k]) === want) ?? null;
  }

  /** Inizio sessione: se la pista è bagnata si parte con le gomme da pioggia */
  private fitWeatherTyres(e: CarEntity, quiet: boolean): void {
    const want = this.weatherCompound(e.vehicle);
    if (!want || tyreClassOf(e.vehicle.car.tire.compounds[want]) === 'slick') return;
    const v = e.vehicle, s = v.car.setup;
    v.fitTyres(want, s.pressureFront, s.pressureRear, this.sim.tyreBlankets ? BLANKET_TEMP : this.sim.airTemp + 3);
    e.compoundsUsed = new Set([v.tires[0].compound.name]);
    if (e.isPlayer) {
      this.pitPlan.compound = want;
      if (!quiet) this.radio(`Pista bagnata: montiamo le <b>${v.tires[0].compound.name}</b>.`, 6, 'importante');
    }
  }

  /** I box dei bot guardano il meteo ogni secondo: gomme sbagliate → rientro subito */
  private botWeatherCalls(): void {
    if (!this.track.pit) return;
    for (const e of this.entities) {
      if (e.isPlayer || e.pit || e.parked || e.competitor.retired || e.competitor.finished) continue;
      const want = this.weatherCompound(e.vehicle);
      if (!want) continue;
      if (e.pitRequest) {
        // sosta già chiesta (benzina, ala...): si cambiano anche le gomme
        e.pitRequest.changeTyres = true;
        e.pitRequest.compound = want;
      } else e.pitRequest = { changeTyres: true, compound: want, addFuel: 0, repair: e.vehicle.damage.frontWing > 0.2 };
    }
  }

  /** Avvisi meteo del box (una volta al secondo): pioggia in arrivo, gomme da cambiare */
  private weatherRadio(): void {
    if (!this.started || this.session.state === 'finita') return;
    const f = this.weather.forecast(240);
    if (f?.kind === 'inizia' && !this.radioSaid.has(`rain${Math.round(this.weather.time / 300)}`) && f.inS < 200) {
      this.radioSaid.add(`rain${Math.round(this.weather.time / 300)}`);
      this.radio(`<b>Pioggia in arrivo</b> tra circa ${f.inS < 60 ? `${f.inS} secondi` : `${Math.round(f.inS / 60)} minuti`}: ${Weather.rainWord(f.peak)}.`, 7, 'importante');
    }
    const call = this.weatherCompoundCall();
    const key = `call${call ? this.weatherCompound(this.vehicle) : ''}`;
    if (call && !this.radioSaid.has(key) && !this.playerEntity.pit) {
      this.radioSaid.add(key);
      this.radio(call, 9, 'importante');
    }
  }

  /** All'arrivo: chi non ha usato due mescole viene squalificato. */
  private checkCompoundRule(e: CarEntity): void {
    if (!e.competitor.finished || e.ruleChecked) return;
    e.ruleChecked = true;
    if (this.compoundRuleActive() && !this.ruleOk(e)) {
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
      if (this.compoundRuleActive() && !this.ruleOk(e) && lapsLeft > 0) {
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

  /** Messaggio radio del box (pannello in alto al centro; i messaggi importanti anche a voce). */
  private radio(html: string, seconds = 6, prio?: RadioPrio): void {
    this.boxRadio?.say(html, { seconds: seconds + 2, prio });
  }

  /**
   * Il pilota chiede qualcosa al box (menu radio o microfono): risposta con i dati veri.
   * @param spoken true se la domanda è arrivata a voce
   */
  private radioAnswer(i: RadioIntent, spoken: boolean): void {
    void spoken;
    const e = this.playerEntity, v = e.vehicle, s = this.session;
    const say = (html: string) => this.boxRadio.say(html, { prio: 'risposta', seconds: 10 });
    const lapsLeft = s.isRace ? Math.max(0, s.config.laps - e.competitor.lapsDone) : null;
    const comp = (id: string) => this.car.tire.compounds[id]?.name ?? id;
    const tread = Math.min(...v.tires.map((t) => t.tread));
    switch (i.type) {
      case 'gomme': {
        const avgT = v.tires.reduce((a, t) => a + t.surfaceTemp, 0) / 4;
        const opt = v.tires[0].compound.optimalTemp;
        const temp = avgT < opt - 20 ? 'ancora fredde' : avgT > opt + 15 ? 'troppo calde, gestiscile' : 'in temperatura';
        const life = e.treadPerLap ? Math.max(0, (tread - 0.2) / e.treadPerLap) : null;
        say(`${v.tires[0].compound.name}: battistrada al ${(tread * 100).toFixed(0)}%, ${temp} (${avgT.toFixed(0)}°)`
          + (life !== null ? `. Ne hanno per circa <b>${Math.floor(life)} giri</b>` : '') + '.');
        break;
      }
      case 'benzina': {
        const perLap = this.fuelPerLapOf(e);
        const laps = v.fuel / perLap;
        let t = `${v.fuel.toFixed(1)} kg, bastano per ${laps.toFixed(1)} giri`;
        if (lapsLeft !== null) {
          t += laps >= lapsLeft + 0.2 ? `: <b>arrivi in fondo</b> (mancano ${lapsLeft} giri).`
            : v.car.pit?.refuel === false ? `: <b>non basta</b>, ne mancano ${lapsLeft}. Risparmia: alza il piede prima delle frenate.`
              : `: <b>non basta</b>, ne mancano ${lapsLeft}. Serve una sosta con ~${Math.ceil((lapsLeft + 0.5) * perLap - v.fuel)} kg.`;
        }
        say(t);
        break;
      }
      case 'distacchi': {
        if (!s.isRace) {
          const best = e.competitor.timing.best?.time;
          say(`Sei P${e.competitor.position} di ${s.competitors.length}` + (best ? `, miglior giro ${best.toFixed(3)}` : '') + (s.timeLeft !== null ? `. Mancano ${fmtClock(s.timeLeft)}.` : '.'));
          break;
        }
        const st = s.standings();
        const k = st.indexOf(e.competitor);
        let t = `P${k + 1}, mancano ${lapsLeft} giri`;
        const ahead = k > 0 ? st[k - 1] : null, behind = k < st.length - 1 ? st[k + 1] : null;
        if (ahead) {
          const at = ahead.timing.timeAtDistance(e.competitor.timing.totalDistance);
          if (at !== null) t += `. Davanti ${ahead.name} a ${(e.competitor.timing.sessionTime - at).toFixed(1)} s`;
        }
        if (behind && !behind.retired) {
          const bt = e.competitor.timing.timeAtDistance(behind.timing.totalDistance);
          if (bt !== null) t += `, dietro ${behind.name} a ${(behind.timing.sessionTime - bt).toFixed(1)} s`;
        }
        say(t + '.');
        break;
      }
      case 'meteo':
        say(this.weatherReport());
        break;
      case 'danni':
        say(this.damageReport());
        break;
      case 'batteria': {
        const h = v.hybrid;
        if (!h.hasErs) { say('Questa auto non ha la batteria.'); break; }
        say(`Batteria al ${(h.charge * 100).toFixed(0)}%, modalità ${ERS_MODE_NAMES[h.mode]}.`
          + (h.overtakeAvailable ? ' <b>Overtake disponibile: premi O.</b>' : '')
          + (h.charge < 0.15 ? " Ricarica un po' prima di attaccare." : ''));
        break;
      }
      case 'strategia':
        say(this.strategyAdvice());
        break;
      case 'mescola':
        if (i.compound) {
          this.pitPlan.compound = i.compound;
          this.pitPlan.changeTyres = true;
        }
        say(`Ricevuto: <b>${comp(this.pitPlan.compound)}</b> alla prossima sosta.`);
        break;
      case 'riparaAla':
        this.pitPlan.repair = true;
        say("Ricevuto, prepariamo un'ala nuova alla prossima sosta (circa 6 secondi in più).");
        break;
      case 'boxOra': {
        if (!this.track.pit) { say("Su questa pista non c'è la corsia box."); break; }
        this.boxCall = true;
        this.boxCallReminded = false;
        this.pitPlan.changeTyres = true;
        const parts = [`gomme ${comp(this.pitPlan.compound)}`];
        if (this.pitPlan.addFuel > 0 && v.car.pit?.refuel !== false) parts.push(`${this.pitPlan.addFuel.toFixed(0)} kg di benzina`);
        if (this.pitPlan.repair) parts.push('ala nuova');
        say(`<b>Box, box, questo giro.</b> Ti aspettiamo: ${parts.join(', ')}. Entra nella corsia box alla fine del giro.`);
        break;
      }
      case 'annullaBox':
        this.boxCall = false;
        say('Ricevuto, resta fuori. Annulliamo la sosta.');
        break;
    }
  }

  /** Consiglio di strategia: quando fermarsi e con che gomme. */
  private strategyAdvice(): string {
    const e = this.playerEntity, v = e.vehicle, s = this.session;
    if (!s.isRace) return 'In prova: fai giri e prendi confidenza, il consumo delle gomme lo misuriamo noi.';
    const wetCall = this.weatherCompoundCall();
    if (wetCall) return wetCall;
    const lapsLeft = Math.max(0, s.config.laps - e.competitor.lapsDone);
    if (lapsLeft <= 0) return 'Ultimo giro: porta a casa la macchina!';
    const tread = Math.min(...v.tires.map((t) => t.tread));
    const life = e.treadPerLap ? (tread - 0.22) / e.treadPerLap : Infinity;
    const fuelLaps = v.fuel / this.fuelPerLapOf(e);
    const needRule = this.compoundRuleActive() && !this.ruleOk(e);
    const comps = this.car.tire.compounds;
    const ids = Object.keys(comps).filter((id) => !comps[id].wet);
    const pickFor = (laps: number) => (laps > 12 ? ids[ids.length - 1] : laps > 6 ? ids[Math.floor(ids.length / 2)] : ids[0]);
    const reasons: string[] = [];
    if (life < lapsLeft) reasons.push(`le gomme durano ancora ~${Math.max(0, Math.floor(life))} giri`);
    if (fuelLaps < lapsLeft && v.car.pit?.refuel !== false) reasons.push(`la benzina basta per ${fuelLaps.toFixed(1)} giri`);
    if (needRule) reasons.push('devi ancora montare la seconda mescola');
    if (!reasons.length) return `Mancano ${lapsLeft} giri: gomme e benzina bastano, <b>restiamo fuori</b> fino alla fine.`;
    const when = Math.max(0, Math.min(Math.floor(life), lapsLeft - 1, needRule ? Math.round(lapsLeft * 0.5) : 99));
    const c = pickFor(lapsLeft - when);
    this.pitPlan.compound = c;
    return `${reasons.join(', ')}: <b>sosta ${when <= 1 ? 'questo giro o il prossimo' : `tra ${when} giri`}</b>, gomme ${comps[c].name}. Dimmi "box" quando vuoi.`;
  }

  /** Meteo per l'HUD (null = asciutto, niente in vista) */
  private weatherHud(): { rain: number; wetness: number; forecast: string } | null {
    const w = this.weather;
    const f = w.forecast(900);
    if (w.mode === 'asciutto' && w.rain < 0.01 && w.wetness < 0.01 && !f) return null;
    const mins = (s: number) => (s < 60 ? `${Math.round(s / 15) * 15} s` : `${Math.round(s / 60)} min`);
    const forecast = !f ? '' : f.kind === 'inizia' ? `Pioggia tra ~${mins(f.inS)}` : `Smette tra ~${mins(f.inS)}`;
    return { rain: w.rain, wetness: w.wetness, forecast: `${WEATHER_NAMES[w.mode]}${forecast ? ' · ' + forecast : ''}` };
  }

  /** Previsioni del tempo per la radio. */
  private weatherReport(): string {
    const w = this.weather;
    let t = `Adesso ${Weather.rainWord(w.rain)}, pista ${Weather.wetWord(w.wetness)}`;
    const f = w.forecast(900);
    if (!f) t += w.rain > 0.05 ? ', e non smette a breve.' : ', niente pioggia in vista per un quarto d\'ora.';
    else if (f.kind === 'inizia') t += `. <b>Pioggia tra circa ${Math.max(1, Math.round(f.inS / 60))} minuti</b> (${Weather.rainWord(f.peak)}).`;
    else t += `. Dovrebbe smettere tra circa ${Math.max(1, Math.round(f.inS / 60))} minuti.`;
    return t + (this.weatherCompoundCall() ? ' ' + this.weatherCompoundCall() : '');
  }

  /** Consiglio sulle gomme se quelle montate non vanno bene per il meteo (null = tutto ok). */
  private weatherCompoundCall(): string | null {
    const want = this.weatherCompound(this.vehicle);
    if (!want || !this.track.pit) return null;
    const c = this.car.tire.compounds[want];
    const why = tyreClassOf(c) === 'slick' ? 'la pista si è asciugata' : tyreClassOf(c) === 'bagnato' ? "c'è troppa acqua" : 'la pista è bagnata';
    this.pitPlan.compound = want;
    this.pitPlan.changeTyres = true;
    return `<b>${why[0].toUpperCase() + why.slice(1)}: box per le ${c.name}?</b> Dimmi "box" e te le prepariamo.`;
  }

  /** Stato dei danni per la radio. */
  private damageReport(): string {
    const d = this.vehicle.damage;
    if (!d.any) return 'La macchina è a posto, nessun danno.';
    let t = `Vediamo: ${d.describe()}.`;
    if (d.puncture.some(Boolean)) t += ' <b>Rientra subito ai box.</b>';
    else if (d.frontWing > 0.25) t += ` L'ala ti costa qualche decimo al giro: la cambiamo alla sosta${this.pitPlan.repair ? ' (già preparata)' : '? Dimmi "cambiate l\'ala"'}.`;
    else t += ' Si può continuare.';
    return t;
  }

  /**
   * Urto: danni all'auto nel punto colpito. Messaggi per il pilota, i bot rientrano se serve,
   * danni gravissimi = ritiro (in prova: l'auto torna ai box riparata).
   */
  private applyDamage(e: CarEntity, px: number, pz: number, speed: number): void {
    if (e.parked || e.pit) return;
    const v = e.vehicle;
    const dx = px - v.x, dz = pz - v.z;
    const sinY = Math.sin(v.yaw), cosY = Math.cos(v.yaw);
    const long = dx * sinY + dz * cosY, lat = dx * cosY - dz * sinY;
    const col = v.car.collision ?? { halfLength: 2.3, halfWidth: 1 };
    const broken = v.damage.hit(long, lat, col.halfLength, col.halfWidth, speed);
    if (!broken.length) return;
    const d = v.damage;
    if (d.fatal && !e.competitor.retired) {
      if (!this.session.isRace) {
        // in prova/qualifica: l'auto viene riportata ai box e riparata
        d.reset();
        if (e.isPlayer) {
          this.radio('<b>Danni troppo gravi: ti riportiamo ai box, la squadra ripara la macchina.</b>', 6, 'urgente');
          if (!this.placeInPits(e)) this.placeOnTrack(e, e.s);
          e.competitor.timing.invalidate('auto riparata');
          e.competitor.timing.resetPosition();
        } else this.resetToTrack(e);
        return;
      }
      e.competitor.retired = true;
      if (e.isPlayer) {
        this.radio(`<b>Danni troppo gravi (${broken.join(', ')}): la gara finisce qui.</b>`, 8, 'urgente');
        this.finishSim = { delay: 5, started: false };
      } else this.radio(`${e.name}: incidente, ritirato.`, 5, 'importante');
      return;
    }
    const compId = (x: Vehicle) => Object.keys(x.car.tire.compounds).find((k) => x.car.tire.compounds[k].name === x.tires[0].compound.name) ?? x.car.setup.compound;
    if (e.isPlayer) {
      if (d.puncture.some(Boolean)) {
        this.pitPlan.changeTyres = true;
        this.radio('<b>Foratura! Rientra ai box piano, la gomma è andata.</b>', 8, 'urgente');
      } else {
        if (d.frontWing > 0.25) this.pitPlan.repair = true;
        this.radio(`<b>Contatto: danni a ${broken.join(', ')}.</b> ${d.frontWing > 0.25 ? 'Prepariamo un\'ala nuova per la sosta.' : 'Controlliamo i dati.'}`, 7, 'importante');
      }
    } else if (this.track.pit && !e.pitRequest && (d.puncture.some(Boolean) || d.frontWing > 0.35)) {
      // il bot rientra: gomme nuove se ha forato, ala nuova se è rotta
      e.pitRequest = { changeTyres: d.puncture.some(Boolean), compound: compId(v), addFuel: 0, repair: d.frontWing > 0.35 };
    }
  }

  /** Velocità dei bot: più piano con l'auto danneggiata */
  private botPace(e: CarEntity): number {
    const f = wetGripFactor(e.vehicle.tires[0].compound, this.weather.wetness);
    // con le gomme sbagliate (slick sul bagnato) si va con molta più prudenza: l'auto scivola
    const wet = Math.sqrt(f) * (f < 0.75 ? 0.9 : 1);
    return e.vehicle.damage.paceFactor() * wet;
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

    // ---- meteo: pioggia e pista bagnata → gomme di tutte le auto ----
    this.weather.update(dt, this.sim.trackTemp);
    {
      const w = this.weather.wetness, r = this.weather.rain;
      for (const e of this.entities) {
        e.vehicle.env.wetness = w;
        e.vehicle.env.trackTemp = this.sim.trackTemp - 14 * w;
        e.vehicle.env.airTemp = this.sim.airTemp - 4 * r;
      }
    }
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      this.weatherTimer = 1;
      this.weatherRadio();
      this.botWeatherCalls();
    }

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
      if (e.parked) return; // portata via dai commissari: non guida e non si muove più
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
        const others = traffic.filter((_, j) => j !== k && !this.entities[j].parked);
        if (this.sc) others.push({ s: this.sc.s, d: this.sc.d, speed: this.sc.vehicle.speed, total: -1e9, offTrack: false });
        e.bot!.paceScale = this.botPace(e) * this.rcPace();
        e.bot!.noPass = this.rc.neutralized || this.rc.noPassUntilLine;
        const cmd = e.bot!.drive(dt, e.s, e.d, e.competitor.timing.totalDistance, others, hold);
        // i bot che hanno finito proseguono piano (giro di rientro)
        input = e.competitor.finished || finished ? { ...cmd, throttle: Math.min(cmd.throttle, 0.25) } : cmd;
      }
      const aids = e.isPlayer ? this.aids : e.bot!.absOff ? BOT_AIDS_NO_ABS : BOT_AIDS;
      e.vehicle.step(dt, input, aids);
    });
    this.updateFlags(traffic, L);
    this.driveSafetyCar(dt);

    // ---- 2) collisioni ----
    const hits = resolveCollisions([...this.entities.filter((e) => !e.parked).map((e) => e.vehicle), ...(this.sc ? [this.sc.vehicle] : [])]);
    this.contactCooldown -= dt;
    for (const h of hits) {
      if (h.speed > 2) this.contactCount++;
      if (h.speed > 5) {
        const byV = (v: Vehicle) => this.entities.find((x) => x.vehicle === v);
        const ea = byV(h.a), eb = byV(h.b);
        // un contatto dura diversi passi: conta solo il primo colpo di ogni coppia (0,6 s)
        const key = ea && eb ? [ea.id, eb.id].sort().join('|') : '';
        if (key && (this.hitCooldown.get(key) ?? 0) <= this.fbClock) {
          this.hitCooldown.set(key, this.fbClock + 0.6);
          if (ea) this.applyDamage(ea, h.px, h.pz, h.speed);
          if (eb) this.applyDamage(eb, h.px, h.pz, h.speed);
        }
      }
      if ((h.a === this.vehicle || h.b === this.vehicle) && h.speed > 2 && this.contactCooldown <= 0) {
        this.hud.message('Contatto!', 1);
        this.contactCooldown = 1;
      }
    }

    // ---- 3) posizione in pista, cronometraggio, sicurezza ----
    for (const e of this.entities) {
      if (e.parked) continue;
      const p = this.track.project(e.vehicle.x, e.vehicle.z, e.hint);
      e.hint = p.index;
      e.s = p.s;
      e.d = p.d;
      e.vehicle.hybrid.inAeroZone = this.aeroZones[p.index] === 1 && !e.pit;
      const allOff = e.vehicle.surfaces.every((s) => s.name === 'erba');
      if (!e.competitor.finished) e.competitor.timing.update(dt, p.s, allOff);
      const fa = this.failAt.get(e);
      if (fa !== undefined && !e.competitor.retired && !e.competitor.finished && e.competitor.timing.totalDistance > fa) this.mechanicalFailure(e);
      if (e.isPlayer) {
        if (Math.abs(p.d) > 120) this.resetToTrack(e); // rete di sicurezza
      } else if (e.competitor.retired) {
        if (!e.parked) this.updateRetired(e, dt);
      } else if (e.vehicle.fuel <= 0 && e.vehicle.speed < 1) {
        e.competitor.retired = true;
        if (this.session.isRace) this.radio(`${e.name} si è ritirato: senza benzina.`, 4);
      } else if (!hold && !e.pit && (Math.abs(p.d) > 35 || e.bot!.stuckTime > 4)) {
        // bot finito lontano o bloccato: torna in pista
        this.resetToTrack(e);
        e.bot!.stuckTime = 0;
      }
    }
    this.updateRaceControl(dt);
    const t = this.player.timing;
    if (t.lap > 0) this.ghostRec.sample(t.current, this.vehicle.x, this.vehicle.z, this.vehicle.yaw);

    if (this.session.state !== 'finita') this.replayRec.record(dt, this.entities);
    this.fbClock += dt;
    if (this.flashbackAllowed()) this.flashback.record(dt, this.fbClock, () => this.takeFlashback());
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
        if (o === e || o.parked) continue;
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
      if (this.entities[j] === me || this.entities[j].parked) return;
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
      // menu radio aperto: batteria su/giù scelgono la voce, flashback lo chiude
      if (this.boxRadio.menuOpen) {
        if (a === 'ersUp') { this.boxRadio.move(-1); continue; }
        if (a === 'ersDown') { this.boxRadio.move(1); continue; }
        if (a === 'flashback') { this.boxRadio.closeMenu(); continue; }
      }
      if (a.startsWith('radio') && a.length === 6) {
        if (this.boxRadio.menuOpen) this.boxRadio.pick(parseInt(a.slice(5)) - 1);
        continue;
      }
      switch (a) {
        case 'radio':
          this.boxRadio.toggleMenu();
          break;
        case 'talk':
          this.boxRadio.listen((why) => this.boxRadio.say(why, { prio: 'info', seconds: 6 }));
          break;
        case 'camera':
          this.hud.message(`Telecamera: ${this.cameras.next()}`, 1);
          break;
        case 'reset':
          if (this.session.state !== 'semaforo') this.resetToTrack(this.playerEntity);
          break;
        case 'flashback':
          this.doFlashback();
          break;
        case 'pause':
          if (this.fb) { this.endFlashback(); break; }
          if (this.finishSim?.started) break; // si stanno calcolando i risultati
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
        case 'ersMode':
        case 'ersUp':
        case 'ersDown': {
          const h = this.vehicle.hybrid;
          if (!h.hasErs) break;
          // dal più "risparmio" al più "spinta": ricarica → bilanciata → attacco
          const order: typeof h.mode[] = ['ricarica', 'bilanciata', 'attacco'];
          const i = order.indexOf(h.mode);
          let j = i;
          if (a === 'ersUp') j = Math.min(order.length - 1, i + 1);
          else if (a === 'ersDown') j = Math.max(0, i - 1);
          else j = (i + 1) % order.length; // tasto unico (gamepad B): giro completo
          if (j === i) {
            this.hud.message(`🔋 Batteria già su ${ERS_MODE_NAMES[h.mode]}`, 1.2);
            break;
          }
          h.mode = order[j];
          const bar = order.map((_, k) => (k <= j ? '▮' : '▯')).join('');
          this.hud.message(`🔋 Batteria ${j > i ? '▲' : '▼'} ${ERS_MODE_NAMES[h.mode]} ${bar}`, 1.5);
          break;
        }
      }
    }
  }

  // =====================================================================
  //  FLASHBACK: torna indietro e rifai la curva (prove libere e qualifica)
  // =====================================================================

  private flashbackAllowed(): boolean {
    const st = this.session.state;
    return st !== 'semaforo' && st !== 'finita' && !this.player.finished && this.rc.state === 'verde' && !this.sc;
  }

  /** Fotografia di tutta la sessione: auto, bot, box, cronometraggio, sessione, fantasma, replay. */
  private takeFlashback() {
    return {
      ents: this.entities.map((e) => ({
        e,
        v: snapshot(e.vehicle),
        c: snapshot(e.competitor),
        b: e.bot ? snapshot(e.bot) : null,
        pit: e.pit ? { ref: e.pit, st: snapshot(e.pit) } : null,
        f: {
          s: e.s, d: e.d, hint: e.hint, wheelHints: [...e.wheelHints], pitHints: [...e.pitHints],
          stall: e.stall, pitRequest: e.pitRequest ? { ...e.pitRequest } : null, pitStops: e.pitStops,
          fuelAtLine: e.fuelAtLine, fuelPerLap: e.fuelPerLap, ruleChecked: e.ruleChecked,
          compoundsUsed: new Set(e.compoundsUsed), parked: e.parked, retireT: e.retireT,
        },
      })),
      session: snapshot(this.session),
      weather: snapshot(this.weather),
      rc: snapshot(this.rc),
      ghost: snapshot(this.ghostRec),
      replay: snapshot(this.replayRec),
      contacts: this.contactCount,
    };
  }

  /** Tasto Flashback: la prima volta torna indietro di 3 s, ogni pressione successiva altri 3 s. */
  private doFlashback(): void {
    if (!this.fb && !this.flashbackAllowed()) return;
    const back = this.fb ? Math.min(this.fb.back + 3, FlashbackBuffer.SECONDS) : 3;
    const now = this.fb ? this.fb.time : this.fbClock;
    const found = this.flashback.find(now, back);
    if (!found) {
      this.hud.message('Flashback non ancora disponibile', 1.5);
      return;
    }
    const st = found.frame.state as ReturnType<Game['takeFlashback']>;
    // si torna esattamente a quel momento, tutti insieme (in gara anche i bot): anche il giro
    // non valido e le penalità prese dopo vengono cancellati
    const wasValid = this.player.timing.valid;
    for (const x of st.ents) {
      const e = x.e;
      restore(e.vehicle, x.v);
      restore(e.competitor, x.c);
      if (e.bot && x.b) restore(e.bot, x.b);
      e.pit = x.pit ? x.pit.ref : null;
      if (x.pit) restore(x.pit.ref, x.pit.st);
      Object.assign(e, {
        ...x.f, wheelHints: [...x.f.wheelHints], pitHints: [...x.f.pitHints],
        pitRequest: x.f.pitRequest ? { ...x.f.pitRequest } : null, compoundsUsed: new Set(x.f.compoundsUsed),
      });
    }
    restore(this.session, st.session);
    restore(this.weather, st.weather);
    restore(this.rc, st.rc);
    if (!this.rc.scOut) this.removeSafetyCar();
    restore(this.ghostRec, st.ghost);
    restore(this.replayRec, st.replay);
    this.contactCount = st.contacts;
    const revalidated = !wasValid && this.player.timing.valid;
    this.fb = { index: found.index, back: now - found.frame.time, time: now, armed: this.fb?.armed ?? false };
    if (!this.loop.paused) {
      this.loop.paused = true;
      this.sound.setPaused(true);
      this.opponentSound.setPaused(true);
    }
    this.hud.message(`⏪ Flashback −${this.fb.back.toFixed(0)} s${revalidated ? ' · giro di nuovo valido' : ''} · Backspace: più indietro · Gas: riparti`, 600);
  }

  private endFlashback(): void {
    if (!this.fb) return;
    const at = this.fbClock - this.fb.back;
    this.flashback.truncate(this.fb.index);
    this.fbClock = at;
    this.fb = null;
    this.hud.message('Via!', 1);
    this.loop.paused = false;
    this.sound.setPaused(false);
    this.opponentSound.setPaused(false);
  }

  /** "Box questo giro": avviso quando manca poco all'ingresso della corsia box */
  private updateBoxCall(): void {
    if (!this.boxCall || !this.track.pit || this.playerEntity.pit) return;
    let toEntry = this.pitEntryS - this.playerEntity.s;
    if (toEntry < 0) toEntry += this.track.length;
    if (toEntry < 500 && toEntry > 50 && !this.boxCallReminded) {
      this.boxCallReminded = true;
      this.radio('<b>Box, box! Entra ai box adesso.</b>', 5, 'urgente');
    } else if (toEntry > this.track.length - 100 && this.boxCallReminded) {
      // ingresso passato senza entrare
      this.boxCall = false;
      this.radio('Hai saltato il box: resta fuori, riproviamo al prossimo giro se vuoi.', 6, 'importante');
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
      this.boxRadio.silence();
      if (!show) return;
      this.overlay.showPause(() => this.togglePause(), [
        { label: '↻ Ricomincia sessione', act: () => this.startSession(this.sessionCfg) },
        this.career && this.session.isRace
          ? { label: '🏳 Ritirati (il resto della gara viene simulato)', act: () => this.retirePlayer() }
          : { label: '🏁 Termina e vedi risultati', act: () => this.endSessionEarly() },
        this.career
          ? { label: '📋 Weekend…', act: () => this.showCareerWeekend() }
          : { label: 'Cambia sessione…', act: () => this.showSessionChoice() },
        { label: '🔧 Assetto', act: () => void this.openSetup() },
        { label: '🛞 Strategia box', act: () => this.openPitPlan() },
        { label: '🎮 Calibra volante', act: () => void this.openWheelCalibration() },
        { label: '⚙ Impostazioni', act: () => openSettings(this.settings, () => this.applySettings()) },
        ...(this.fromEditor ? [{ label: "✎ Torna all'editor", act: () => navigate('editor', { pista: this.trackId }) }] : []),
        this.career
          ? { label: '🏆 Torna alla carriera (il weekend non viene salvato)', act: () => navigate('carriera', { id: this.career!.id }) }
          : { label: 'Menu principale', act: () => navigate('menu') },
      ]);
    }
  }

  // =====================================================================
  //  MODALITÀ CARRIERA: weekend (prove, qualifica, gara)
  // =====================================================================

  /** Avversari della carriera: i piloti delle scuderie, ognuno con l'auto della sua scuderia. */
  private careerRoster() {
    const c = this.career!;
    const cars = new Map<string, CarParams>();
    return racingDrivers(c).filter((d) => d.id !== PLAYER_ID).slice(0, 19).map((d) => {
      const t = teamOf(c, d.teamId);
      if (!cars.has(t.id)) {
        const car = structuredClone(this.rawCar);
        applyCarLevels(car, t.car);
        cars.set(t.id, car);
      }
      return { id: d.id, name: d.name, color: t.color, number: d.number, skill: botSkillOf(c, d), car: cars.get(t.id)! };
    });
  }

  /** Menu del weekend: le sessioni da fare, in ordine. */
  private showCareerWeekend(): void {
    const c = this.career!;
    this.loop.paused = true;
    if (this.started) { this.sound.setPaused(true); this.opponentSound.setPaused(true); }
    const round = c.calendar[c.round];
    if (!round || round.trackId !== this.trackId || c.offers) {
      this.overlay.showResults('Carriera', '<p>Questo weekend non è più in programma.</p>', [
        { label: '🏆 Torna alla carriera', primary: true, act: () => navigate('carriera', { id: c.id }) },
      ]);
      return;
    }
    const team = playerTeam(c);
    const laps = raceLaps(c, round);
    const st = this.careerStage;
    const step = (k: typeof st, label: string) => {
      const order = ['libere', 'qualifica', 'gara', 'fatto'];
      const done = order.indexOf(st) > order.indexOf(k);
      return `<li class="${k === st ? 'cur' : done ? 'done' : ''}">${done ? '✔' : k === st ? '▶' : '·'} ${label}</li>`;
    };
    const html = `
      <p><b>${round.trackName}</b> · gara ${c.round + 1} di ${c.calendar.length} · stagione ${c.season}</p>
      <p>${team.name} · ${playerDriver(c).name} #${playerDriver(c).number} · obiettivo ${ordinal(c.objective)} tra i costruttori</p>
      <p>Meteo previsto: <b>${WEATHER_NAMES[this.careerWeather()]}</b></p>
      <ul class="weekend">
        ${c.practiceMinutes > 0 ? step('libere', `Prove libere (${c.practiceMinutes} min)`) : ''}
        ${step('qualifica', `Qualifica (${c.qualiMinutes} min)`)}
        ${step('gara', `Gara (${laps} giri)`)}
      </ul>
      <p class="small">Rischio guasto in gara: ${(failureChance(team.car) * 100).toFixed(0)}%. Puoi saltare prove e qualifica (senza qualifica parti ultimo).</p>`;
    const actions: { label: string; act: () => void; primary?: boolean }[] = [];
    if (st === 'libere') {
      actions.push({ label: `▶ Prove libere`, primary: true, act: () => this.beginCareerSession('libere') });
      actions.push({ label: 'Salta le prove', act: () => { this.careerStage = 'qualifica'; this.showCareerWeekend(); } });
    } else if (st === 'qualifica') {
      actions.push({ label: `▶ Qualifica`, primary: true, act: () => this.beginCareerSession('qualifica') });
      actions.push({ label: 'Salta (parti ultimo)', act: () => { this.lastQualiOrder = null; this.careerStage = 'gara'; this.showCareerWeekend(); } });
    } else if (st === 'gara') {
      actions.push({ label: `▶ Gara (${laps} giri)`, primary: true, act: () => this.beginCareerSession('gara') });
    }
    actions.push(
      { label: '🔧 Assetto', act: () => void this.openSetup() },
      { label: '🎮 Calibra volante', act: () => void this.openWheelCalibration() },
      { label: '🏆 Torna alla carriera', act: () => navigate('carriera', { id: c.id }) },
    );
    this.overlay.showResults('Weekend di gara', html, actions);
  }

  private beginCareerSession(type: 'libere' | 'qualifica' | 'gara'): void {
    const c = this.career!;
    if (!this.started) {
      this.started = true;
      this.sound.start();
      this.opponentSound.start();
      this.applySettings();
    }
    this.sound.setPaused(false);
    this.opponentSound.setPaused(false);
    this.startSession({
      ...this.sessionCfg,
      type,
      minutes: type === 'libere' ? c.practiceMinutes : type === 'qualifica' ? c.qualiMinutes : 0,
      laps: raceLaps(c, c.calendar[c.round]),
      opponents: Math.min(19, racingDrivers(c).length - 1),
      difficulty: c.difficulty,
      grid: this.lastQualiOrder ? 'qualifica' : 'fondo',
      wearMultiplier: 1,
      fuelMultiplier: 1,
      weather: this.careerWeather(),
    });
  }

  /**
   * Meteo del weekend di carriera: deciso dalla stagione e dalla gara (uguale per tutte le
   * sessioni del weekend): 70% asciutto, 20% variabile, 10% pioggia.
   */
  private careerWeather(): WeatherMode {
    const c = this.career!;
    let h = (c.season * 7919 + c.round * 104729 + c.id.length * 31) % 1000;
    h = (h * 2654435761) % 1000;
    const x = h / 1000;
    return x < 0.7 ? 'asciutto' : x < 0.9 ? 'variabile' : 'pioggia';
  }

  /** Risultati di una sessione del weekend; dopo la gara si salva il risultato nella carriera. */
  private showCareerResults(html: string): void {
    const c = this.career!;
    const type = this.session.config.type;
    const actions: { label: string; act: () => void; primary?: boolean }[] = [];
    if (type === 'libere') {
      this.careerStage = 'qualifica';
      actions.push({ label: '▶ Avanti: qualifica', primary: true, act: () => this.showCareerWeekend() });
      actions.push({ label: '↻ Ripeti le prove', act: () => this.startSession(this.sessionCfg) });
    } else if (type === 'qualifica') {
      this.careerStage = 'gara';
      actions.push({ label: '▶ Avanti: gara', primary: true, act: () => this.showCareerWeekend() });
      actions.push({ label: '↻ Ripeti la qualifica', act: () => this.startSession(this.sessionCfg) });
    } else {
      this.careerStage = 'fatto';
      if (!this.careerSaved) {
        this.careerSaved = true;
        this.saveCareerRace();
      }
      const me = c.results[c.results.length - 1]?.rows.find((x) => x.driverId === PLAYER_ID);
      const dPos = driverStandings(c).findIndex((x) => x.id === PLAYER_ID) + 1;
      const tPos = teamStandings(c).findIndex((x) => x.id === playerTeam(c).id) + 1;
      html = `<p class="career-race">${me ? `<b>${me.points} punti</b> · ` : ''}campionato: ${ordinal(dPos)} tra i piloti, ${playerTeam(c).name} ${ordinal(tPos)} tra i costruttori (obiettivo ${ordinal(c.objective)}) · cassa ${playerTeam(c).budget.toFixed(1)} M</p>` + html;
      actions.push({ label: '🏆 Torna alla carriera', primary: true, act: () => navigate('carriera', { id: c.id }) });
      if (this.replayRec.frames.length > 20) actions.push({ label: '🎬 Replay', act: () => this.startReplay() });
    }
    actions.push({ label: '🏆 Esci dal weekend', act: () => navigate('carriera', { id: c.id }) });
    this.overlay.showResults(`${SESSION_NAMES[type]} · Risultati`, html, type === 'gara' ? actions.slice(0, -1) : actions);
  }

  /** Ordine d'arrivo della gara → punti, soldi e sviluppo nella carriera (salvata subito). */
  private saveCareerRace(): void {
    const c = this.career!;
    const st = this.session.standings();
    const leader = st[0];
    const rows = st.map((comp) => ({
      driverId: comp.id === 'pilota' ? PLAYER_ID : comp.id,
      status: comp.dsq ? 'squalificato' as const : comp.retired ? 'ritirato' as const : 'arrivato' as const,
      lapsDown: Math.max(0, (leader?.finishLaps ?? leader?.lapsDone ?? 0) - (comp.finished ? comp.finishLaps : comp.lapsDone)),
    }));
    recordRace(c, rows, this.raceGrid.map((id) => (id === 'pilota' ? PLAYER_ID : id)), false);
    CareerStore.save(c).catch((e) => this.hud.message(`Errore nel salvataggio della carriera: ${e}`, 5));
  }

  /** Guasti della gara: per ogni auto, in base all'affidabilità della sua scuderia. */
  private planFailures(): void {
    const c = this.career!;
    const dist = this.sessionCfg.laps * this.track.length;
    for (const e of this.entities) {
      const d = e.isPlayer ? playerDriver(c) : c.drivers.find((x) => x.id === e.id);
      if (!d) continue;
      if (Math.random() < failureChance(teamOf(c, d.teamId).car)) this.failAt.set(e, dist * (0.08 + Math.random() * 0.85));
    }
  }

  /**
   * Auto ritirata (guasto, senza benzina, danni): accosta fuori pista e si ferma; poi i commissari
   * la portano via. Ferma fuori dalla carreggiata basta poco; in mezzo alla pista ci vuole di più
   * (in gara è il momento della safety car). Tolta di scena non è più vista da nessuno.
   */
  private updateRetired(e: CarEntity, dt: number): void {
    e.bot!.pullOver = true;
    const v = e.vehicle;
    const onTrack = Math.abs(e.d) < this.track.at(e.hint).width / 2 + 1;
    e.retireT += dt;
    const stopped = v.speed < 1.5;
    const wait = !this.session.isRace ? 5 : onTrack ? this.marshalTimeOnTrack() : this.rc.state === 'vsc' ? 14 : 8;
    if ((stopped && e.retireT > wait) || e.retireT > 45) this.parkRetired(e);
  }

  /** Tempo che serve ai commissari per togliere un'auto ferma in pista (gara). */
  private marshalTimeOnTrack(): number {
    return this.rc.state === 'sc' ? 30 : 15;
  }

  // =====================================================================
  //  DIREZIONE GARA: VSC, SAFETY CAR, BANDIERA ROSSA (vedi race/RaceControl.ts)
  // =====================================================================

  /** Comunicazione della direzione gara (safety car, bandiere...). */
  private raceControlMsg(html: string, prio: RadioPrio = 'urgente'): void {
    this.boxRadio?.say(html, { from: 'direzione', prio, seconds: 9 });
  }

  /** Velocità limite VSC nel punto s (m/s): ~60% del passo normale */
  private vscLimit(s: number): number {
    this.vscProfile ??= this.line.speedProfile(this.car, 1, 1);
    const n = this.line.n;
    const i = Math.round((((s % this.track.length) + this.track.length) % this.track.length) / (this.track.length / n)) % n;
    return this.vscProfile[i] * 0.6;
  }

  /** Ritmo dei bot sotto neutralizzazione */
  private rcPace(): number {
    const rc = this.rc;
    if (rc.state === 'vsc' || (rc.state === 'sc' && !rc.scOut)) return 0.6;
    if (rc.state === 'sc') return 0.85; // si raggiunge la coda, poi si segue chi è davanti
    return 1;
  }

  /** Posizione del pilota tra le auto in pista (senza chi è ai box o ritirato) */
  private activePosition(): number {
    const me = this.playerEntity.competitor.timing.totalDistance;
    let pos = 1;
    for (const e of this.entities) {
      if (e.isPlayer || e.pit || e.parked || e.competitor.retired || e.competitor.finished) continue;
      if (e.competitor.timing.totalDistance > me) pos++;
    }
    return pos;
  }

  private penalize(e: CarEntity, why: string): void {
    e.competitor.penalty += 5;
    if (e.isPlayer) this.raceControlMsg(`<b>Penalità di 5 secondi</b>: ${why}.`);
  }

  /** Ogni passo, in gara: auto ferme → VSC / safety car / bandiera rossa; regole per il pilota. */
  private updateRaceControl(dt: number): void {
    const s = this.session, rc = this.rc;
    if (!s.isRace || s.state !== 'corsa' || rc.state === 'rossa') return;
    rc.t += dt;
    // ---- auto ferme dopo un ritiro (in pista o subito fuori) ----
    let onTrack = 0, near = 0;
    let incident: 'sc' | 'vsc' | null = null;
    for (const e of this.entities) {
      if (!e.competitor.retired || e.parked || e.pit || (e.isPlayer && this.finishSim?.started)) { delete rc.stoppedT[e.id]; continue; }
      const half = this.track.at(e.hint).width / 2;
      const ad = Math.abs(e.d);
      if (e.vehicle.speed < 3 && ad < half + 7) rc.stoppedT[e.id] = (rc.stoppedT[e.id] ?? 0) + dt;
      else delete rc.stoppedT[e.id];
      if ((rc.stoppedT[e.id] ?? 0) < 3) continue;
      const inTrack = ad < half + 0.5;
      if (inTrack) onTrack++; else near++;
      if (!rc.handled[e.id]) {
        rc.handled[e.id] = true;
        // ferma in pista: safety car; vicino al bordo: di solito VSC (a volte basta la gialla)
        if (inTrack) incident = 'sc';
        else if (incident !== 'sc' && Math.random() < 0.7) incident = 'vsc';
      }
    }
    // ---- bandiera rossa: incidente multiplo o pioggia troppo forte ----
    rc.rainT = this.weather.rain > 0.85 ? rc.rainT + dt : 0;
    if (onTrack + near >= 3) return this.redFlag('incidente con più auto ferme in pista');
    if (rc.rainT > 15) return this.redFlag('pioggia troppo forte, pista impraticabile');

    if (incident === 'sc' && rc.state !== 'sc') this.deploySafetyCar();
    else if (incident === 'vsc' && rc.state === 'verde' && !rc.noPassUntilLine) this.deployVsc();

    const clear = onTrack + near === 0;
    rc.clearT = clear ? rc.clearT + dt : 0;
    if (rc.state === 'vsc' && rc.clearT > 8) {
      rc.state = 'verde';
      rc.t = 0;
      this.raceControlMsg('<b>VSC finita: bandiera verde!</b> Si torna a correre.', 'importante');
    }
    if (rc.state === 'sc') {
      if (!rc.scOut && rc.t > 5) this.spawnSafetyCar();
      // la safety car rientra quando arriva all'ingresso dei box (o a fine giro)
      if (rc.ending && this.sc) {
        const L = this.track.length;
        let toEntry = (this.track.pit ? this.pitEntryS : L - 60) - this.sc.s;
        if (toEntry < 0) toEntry += L;
        if (toEntry < 30 || toEntry > L - 20) {
          this.removeSafetyCar();
          rc.state = 'verde';
          rc.noPassUntilLine = true;
          rc.t = 0;
          this.raceControlMsg('Safety car ai box: <b>si riparte dal traguardo</b>, niente sorpassi fino alla linea.', 'importante');
        }
      }
    }

    // ---- regole per il pilota ----
    const me = this.playerEntity;
    if (me.competitor.retired || me.competitor.finished || me.pit) { rc.gainT = rc.overT = 0; return; }
    if (rc.neutralized || rc.noPassUntilLine) {
      const pos = this.activePosition();
      if (pos < rc.refPos) {
        rc.gainT += dt;
        if (rc.gainT > 1 && rc.gainT - dt <= 1) this.raceControlMsg('Hai sorpassato in regime di neutralizzazione: <b>restituisci la posizione</b>.');
        if (rc.gainT > 8) { this.penalize(me, 'sorpasso sotto safety car/VSC'); rc.refPos = pos; rc.gainT = 0; }
      } else { rc.refPos = pos; rc.gainT = 0; }
    }
    if (rc.state === 'vsc' || (rc.state === 'sc' && !rc.scOut)) {
      const lim = this.vscLimit(me.s);
      if (me.vehicle.speed > lim + 3) {
        rc.overT += dt;
        if (rc.overT > 3) { this.penalize(me, 'velocità oltre il limite della VSC'); rc.overT = 0; }
      } else rc.overT = Math.max(0, rc.overT - dt * 0.5);
    }
    // sorpasso della safety car
    if (this.sc && rc.scOut && !rc.passedSc) {
      let g = this.sc.s - me.s;
      const L = this.track.length;
      if (g > L / 2) g -= L;
      if (g < -L / 2) g += L;
      if (g < -3 && g > -15 && this.scPrevGap > 0 && this.scPrevGap < 30) { rc.passedSc = true; this.penalize(me, 'sorpasso della safety car'); }
      this.scPrevGap = g;
    }
  }

  private deployVsc(): void {
    const rc = this.rc;
    rc.state = 'vsc';
    rc.t = 0;
    rc.clearT = 0;
    rc.refPos = this.activePosition();
    this.raceControlMsg('<b>VIRTUAL SAFETY CAR</b>: rallenta (limite nell\'HUD), niente sorpassi.');
  }

  private deploySafetyCar(): void {
    const rc = this.rc;
    rc.state = 'sc';
    rc.t = 0;
    rc.clearT = 0;
    rc.scLaps = 0;
    rc.ending = false;
    rc.scOut = false;
    rc.passedSc = false;
    rc.refPos = this.activePosition();
    this.raceControlMsg('<b>SAFETY CAR</b>: auto ferma in pista. Rallenta, niente sorpassi.');
    // occasione per fermarsi: i bot con gomme usate (o senza la seconda mescola) rientrano
    const s = this.session;
    for (const e of this.entities) {
      if (e.isPlayer || e.pit || e.pitRequest || e.competitor.retired || !this.track.pit) continue;
      const lapsLeft = s.config.laps - e.competitor.lapsDone;
      const tread = Math.min(...e.vehicle.tires.map((t) => t.tread));
      const rule = this.compoundRuleActive() && !this.ruleOk(e);
      if (lapsLeft > 2 && (tread < 0.7 || rule)) {
        const comps = e.vehicle.car.tire.compounds;
        const slick = Object.keys(comps).filter((k) => !comps[k].wet && comps[k].name !== e.vehicle.tires[0].compound.name);
        const pick = this.weatherCompound(e.vehicle) ?? (rule && slick.length ? (lapsLeft > 10 ? slick[slick.length - 1] : slick[0]) : this.compoundIdOf(e.vehicle));
        e.pitRequest = { changeTyres: true, compound: pick, addFuel: 0, repair: e.vehicle.damage.frontWing > 0.15 };
      }
    }
    if (this.track.pit && !this.playerEntity.competitor.retired) {
      this.radio('Safety car! <b>Occasione per fermarsi</b>: dimmi "box" se vuoi gomme nuove.', 8, 'importante');
    }
  }

  /** La safety car entra in pista davanti al leader */
  private spawnSafetyCar(): void {
    const rc = this.rc;
    rc.scOut = true;
    const leader = this.session.standings().map((c) => this.entities.find((e) => e.competitor === c)!).find((e) => e && !e.competitor.retired && !e.parked);
    if (!leader) return;
    if (!this.sc) {
      const rig = cloneRig(this.playerRig, '#f2b705', 0);
      const ent = this.createEntity('safety-car', 'Safety car', false, structuredClone(this.botCar), rig);
      ent.bot = new BotDriver(this.line, ent.vehicle, { grip: 0.8, brake: 0.75, inconsistency: 0, errorRate: 0, aggression: 0 });
      ent.bot.speedCap = 200 / 3.6;
      ent.bot.noPass = true;
      this.renderer.scene.add(rig.root);
      this.sc = ent;
    }
    // davanti al leader, dove non c'è nessuno
    const L = this.track.length;
    let s0 = leader.s + 160;
    for (let k = 0; k < 6; k++) {
      const busy = this.entities.some((e) => !e.parked && Math.abs(((e.s - s0 + L * 1.5) % L) - L / 2) < 40);
      if (!busy) break;
      s0 += 60;
    }
    this.placeOnLine(this.sc, ((s0 % L) + L) % L);
    // parte già in movimento
    const v = this.sc.vehicle, sp = 35;
    v.vx = Math.sin(v.yaw) * sp;
    v.vz = Math.cos(v.yaw) * sp;
    v.tires.forEach((t) => (t.omega = sp / v.car.wheelRadius));
    this.scPrevGap = 0;
    this.raceControlMsg('La <b>safety car</b> è in pista: mettiti in coda.', 'importante');
  }

  private removeSafetyCar(): void {
    if (!this.sc) return;
    this.renderer.scene.remove(this.sc.view.rig.root);
    this.sc = null;
  }

  /** La safety car guida (non è un concorrente: niente classifica né cronometro) */
  private driveSafetyCar(dt: number): void {
    const sc = this.sc;
    if (!sc) return;
    const p = this.track.project(sc.vehicle.x, sc.vehicle.z, sc.hint);
    sc.hint = p.index;
    sc.s = p.s;
    sc.d = p.d;
    const cmd = sc.bot!.drive(dt, sc.s, sc.d, -1e9, [], false);
    sc.vehicle.step(dt, cmd, BOT_AIDS);
  }

  /** Il leader passa sul traguardo: giri della safety car, rientro, bandiera verde */
  private rcLeaderLine(e: CarEntity): void {
    const s = this.session, rc = this.rc;
    if (!s.isRace || s.state !== 'corsa' || s.standings()[0] !== e.competitor) return;
    if (rc.noPassUntilLine) {
      rc.noPassUntilLine = false;
      this.raceControlMsg('<b>Bandiera verde!</b> Si torna a correre.', 'importante');
      return;
    }
    if (rc.state === 'sc' && rc.scOut) {
      rc.scLaps++;
      if (!rc.ending && rc.scLaps >= 2 && rc.clearT > 5) {
        rc.ending = true;
        this.raceControlMsg('La safety car <b>rientra alla fine di questo giro</b>.', 'importante');
      }
    }
  }

  /** BANDIERA ROSSA: gara sospesa, poi ripartenza da fermo in griglia */
  private redFlag(reason: string): void {
    const rc = this.rc;
    rc.state = 'rossa';
    rc.reason = reason;
    this.removeSafetyCar();
    this.loop.paused = true;
    this.sound.setPaused(true);
    this.opponentSound.setPaused(true);
    this.boxRadio.silence();
    this.raceControlMsg(`<b>BANDIERA ROSSA</b>: ${reason}.`);
    const comps = this.car.tire.compounds;
    const sel = this.weatherCompound(this.vehicle) ?? this.compoundIdOf(this.vehicle);
    const st = this.session.standings().filter((c) => !c.retired).slice(0, 12);
    const html = `
      <p><b>${reason[0].toUpperCase() + reason.slice(1)}.</b> La gara è sospesa: si riparte <b>da fermo, in griglia</b>,
      nell'ordine della classifica. I giri fatti restano; i danni vengono riparati e si possono cambiare le gomme.</p>
      <div class="form"><label>Gomme per la ripartenza <select data-red>${Object.entries(comps).map(([id, c]) => `<option value="${id}" ${id === sel ? 'selected' : ''}>${c.name}</option>`).join('')}</select></label></div>
      <p class="small">Meteo: ${Weather.rainWord(this.weather.rain)}, pista ${Weather.wetWord(this.weather.wetness)}${reason.includes('pioggia') ? ' (si aspetta che smetta di piovere così forte)' : ''}.</p>
      <ol class="weekend">${st.map((c) => `<li class="${c.isPlayer ? 'cur' : ''}">${c.name}</li>`).join('')}</ol>`;
    this.overlay.showResults('🟥 Bandiera rossa', html, [{
      label: '🚦 Ripartenza', primary: true,
      act: () => this.restartAfterRed((document.querySelector('[data-red]') as HTMLSelectElement | null)?.value ?? sel),
    }]);
  }

  private restartAfterRed(compound: string): void {
    const rc = this.rc;
    // pioggia troppo forte: si aspetta che cali (il meteo va avanti)
    if (rc.reason.includes('pioggia')) {
      for (let k = 0; k < 240 && this.weather.rainAt(this.weather.time) > 0.6; k++) this.weather.update(15, this.sim.trackTemp);
      this.weather.wetness = Math.min(this.weather.wetness, 0.85);
    }
    for (const e of this.entities) if (e.competitor.retired && !e.parked) this.parkRetired(e);
    const order = this.session.standings()
      .map((c) => this.entities.find((e) => e.competitor === c)!)
      .filter((e) => e && !e.parked && !e.competitor.retired);
    const L = this.track.length;
    order.forEach((e, k) => {
      e.pit = null;
      e.pitRequest = null;
      e.vehicle.speedLimiter = 0;
      e.vehicle.damage.reset();
      const v = e.vehicle, s = v.car.setup;
      const id = e.isPlayer ? compound : this.weatherCompound(v) ?? this.compoundIdOf(v);
      v.fitTyres(id, s.pressureFront, s.pressureRear, this.sim.tyreBlankets ? BLANKET_TEMP : this.sim.airTemp + 20);
      e.compoundsUsed.add(v.tires[0].compound.name);
      e.treadAtLine = 1;
      if (k < this.track.grid.length) {
        const g = this.track.grid[k];
        this.placeAt(e, g.x, g.z, g.heading);
      } else this.placeOnLine(e, L - 6 - k * 8);
      e.startX = v.x;
      e.startZ = v.z;
      e.competitor.timing.redRestart(e.s);
      if (e.bot) e.bot.stuckTime = 0;
    });
    if (this.playerEntity.isPlayer) this.pitPlan.compound = compound;
    rc.reset();
    this.session.restart();
    this.flashback.clear();
    this.fb = null;
    this.overlay.hide();
    this.loop.paused = false;
    this.sound.setPaused(false);
    this.opponentSound.setPaused(false);
    this.raceControlMsg('Ripartenza da fermo: <b>attendi lo spegnimento dei semafori</b>.', 'importante');
  }


  /** Toglie di scena un'auto ritirata (finita "nel garage"). */
  private parkRetired(e: CarEntity): void {
    e.parked = true;
    const k = this.entities.indexOf(e);
    e.vehicle.reset(1e5 + k * 50, 1e5, 0);
    e.competitor.timing.resetPosition();
  }

  private mechanicalFailure(e: CarEntity): void {
    this.failAt.delete(e);
    e.competitor.retired = true;
    e.vehicle.fuel = 0; // il motore si spegne: l'auto rallenta fino a fermarsi
    const what = ['al motore', 'al cambio', 'idraulico', 'elettrico', 'ai freni'][Math.floor(Math.random() * 5)];
    if (e.isPlayer) {
      this.hud.message(`💥 Guasto ${what}: sei fuori dalla gara`, 5);
      this.finishSim = { delay: 4, started: false };
    } else {
      this.radio(`${e.name}: guasto ${what}, ritirato.`, 4);
    }
  }

  /** Ritiro volontario in gara (carriera): il resto viene simulato. */
  private retirePlayer(): void {
    this.overlay.hide();
    this.player.retired = true;
    this.finishSim = { delay: 0, started: false };
    this.loop.paused = false;
  }

  /**
   * Il pilota ha tagliato il traguardo: invece di aspettare che tutti finiscano l'ultimo giro,
   * l'auto rientra ai box e la gara degli altri viene simulata velocemente (qualche decimo di
   * secondo a fotogramma, senza disegnare) fino all'arrivo dell'ultimo. Poi i risultati.
   */
  private finishRace(frameDt: number): void {
    const fs = this.finishSim!;
    if (fs.delay > 0) {
      fs.delay -= frameDt;
      return;
    }
    if (!fs.started) {
      fs.started = true;
      const me = this.playerEntity;
      if (!this.placeInPits(me)) me.vehicle.reset(1e5, 1e5, 0); // fuori dai piedi degli avversari
      me.competitor.timing.resetPosition();
      this.loop.paused = true;
      this.sound.setPaused(true);
      this.opponentSound.setPaused(true);
      this.hud.message('🏁 Arrivo degli avversari…', 60);
    }
    const dt = this.loop.fixedDt;
    const t0 = performance.now();
    while (this.session.state !== 'finita' && performance.now() - t0 < 60) this.fixedUpdate(dt);
    if (this.session.state === 'finita') {
      this.finishSim = null;
      this.resultsTimer = Math.min(this.resultsTimer, 0.3);
    }
  }

  /** Avvia il replay della sessione appena conclusa. */
  private startReplay(): void {
    this.overlay.hide();
    this.sound.setPaused(true);
    this.opponentSound.setPaused(true);
    this.loop.paused = false;
    for (const e of this.entities) e.view.rig.root.visible = true;
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
    this.renderer.applyStyle(s);
    this.sound.setVolume(s.volume);
    if (this.boxRadio) this.boxRadio.opts = { voice: s.radioVoice, volume: Math.min(1, s.radioVolume * Math.max(0.3, s.volume * 2)) };
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
      if (e.isPlayer || e.parked) continue;
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
    this.boxRadio.update(frameDt);
    this.updateBoxCall();
    if (this.fb) {
      // si riparte premendo l'acceleratore (prima va rilasciato, se era già premuto)
      const thr = this.input.read(frameDt, 0, false).throttle;
      if (thr < 0.1) this.fb.armed = true;
      else if (this.fb.armed && thr > 0.4) this.endFlashback();
    }
    const v = this.vehicle;
    for (const e of this.entities) {
      e.view.rig.root.visible = !e.parked;
      if (!e.parked) e.view.update(alpha);
    }
    this.sc?.view.update(alpha);
    this.cameras.update(frameDt, v.speed);
    this.rainFx.update(frameDt, this.renderer.camera, this.weather.rain, this.weather.wetness, this.entities.map((e) => ({
      key: e, x: e.vehicle.x, z: e.vehicle.z, yaw: e.vehicle.yaw, speed: e.vehicle.speed, visible: !e.parked,
    })));
    this.renderer.followShadows(this.playerEntity.view.position);

    if (this.resultsTimer > 0) {
      this.resultsTimer -= frameDt;
      if (this.resultsTimer <= 0) this.showResults();
    }
    if (this.finishSim) this.finishRace(frameDt);

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
      rc: this.rc.banner(this.rc.state === 'vsc' || (this.rc.state === 'sc' && !this.rc.scOut) ? this.vscLimit(this.playerEntity.s) * 3.6 : null),
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
      tyres: v.tires.map((ty, i) => ({
        temp: ty.surfaceTemp, core: ty.coreTemp, pressure: ty.pressure,
        tread: ty.tread, grip: ty.gripFactor, optimal: ty.compound.optimalTemp, puncture: v.damage.puncture[i],
      })),
      weather: this.weatherHud(),
      damage: v.damage.any ? {
        frontWing: v.damage.frontWing, rearWing: v.damage.rearWing, floor: v.damage.floor,
        suspension: v.damage.suspension, engine: v.damage.engine,
      } : null,
    }, frameDt);

    // minimappa (nascosta quando a destra c'è la telemetria o l'elenco dei giri)
    this.minimap.visible = !this.hud.telemetry.classList.contains('show') && this.hud.lapList.style.display !== 'block';
    this.minimap.update(this.entities.filter((e) => !e.parked).map((e) => ({
      x: e.vehicle.x, z: e.vehicle.z, yaw: e.vehicle.yaw, color: e.color ?? '#ffffff', player: e.isPlayer,
      dim: !!e.pit || e.competitor.retired,
    })).concat(this.sc ? [{ x: this.sc.vehicle.x, z: this.sc.vehicle.z, yaw: this.sc.vehicle.yaw, color: '#f2b705', player: false, dim: false }] : []));

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
