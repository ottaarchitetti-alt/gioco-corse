/**
 * Il "regista": carica auto e pista, crea tutti i sistemi e li collega.
 * Fase 1 = prove libere in solitaria. Dalla Fase 4 le sessioni
 * (prove, qualifica, gara) avranno una classe dedicata in src/race.
 */
import { EngineSound } from '../audio/EngineSound';
import { GameLoop } from '../core/GameLoop';
import { formatLapTime, MS_TO_KMH } from '../core/math';
import { loadJSON, saveJSON } from '../core/storage';
import { InputManager } from '../input/InputManager';
import { loadCar, type CarParams } from '../physics/CarParams';
import { Vehicle, type DrivingAids, type GroundContact, type Surface } from '../physics/Vehicle';
import { TelemetryGraph } from '../ui/TelemetryGraph';
import { LapTimer } from '../race/LapTimer';
import { loadCarRig } from '../render/AssetManager';
import { CameraRig } from '../render/CameraRig';
import { CarView } from '../render/CarView';
import { Renderer } from '../render/Renderer';
import { geometryHash } from '../track/TrackData';
import { TrackStore } from '../storage/TrackStore';
import { navigate } from '../ui/router';
import { buildTrackMesh } from '../track/TrackMeshBuilder';
import { KERB_WIDTH, TrackSpline } from '../track/TrackSpline';
import { DebugPanel, type SimSettings } from '../ui/DebugPanel';
import { Hud } from '../ui/Hud';
import { Overlay } from '../ui/Overlay';

const CAR_URL = 'cars/gt_segnaposto.car.json';

/** Superfici (Fase 7/8: valori diversi con pioggia, sporco, gomma depositata). */
const SURFACES: Record<Surface['name'], Surface> = {
  asfalto: { name: 'asfalto', grip: 1, drag: 0 },
  cordolo: { name: 'cordolo', grip: 0.93, drag: 0.005 },
  erba: { name: 'erba', grip: 0.55, drag: 0.06 },
};

const DEFAULT_AIDS: DrivingAids = { abs: true, tc: true, autoShift: true, keyboardSteerAssist: true };
const DEFAULT_SIM: SimSettings = { airTemp: 22, trackTemp: 32, wearMultiplier: 1, tyreBlankets: false };
/** Temperatura delle gomme montate con le termocoperte (°C) */
const BLANKET_TEMP = 80;

export class Game {
  private renderer!: Renderer;
  private input = new InputManager();
  private sound = new EngineSound();
  private aids: DrivingAids = loadJSON('aids', DEFAULT_AIDS);
  private sim: SimSettings = loadJSON('sim', DEFAULT_SIM);
  private graph!: TelemetryGraph;
  private car!: CarParams;
  private track!: TrackSpline;
  private vehicle!: Vehicle;
  private view!: CarView;
  private cameras!: CameraRig;
  private timer!: LapTimer;
  private hud!: Hud;
  private overlay!: Overlay;
  private debug!: DebugPanel;
  private loop!: GameLoop;

  /** Ultimo indice di campione pista per ogni ruota e per il baricentro (ricerca veloce). */
  private wheelHints = [-1, -1, -1, -1];
  private pitHints = [-1, -1, -1, -1];
  private carHint = -1;
  private carS = 0;
  private carD = 0;
  private telemetryTimer = 0;
  private lastSteer = 0;
  private started = false;

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

    // ---- Pista ----
    this.track = new TrackSpline(trackData);
    this.renderer.scene.add(buildTrackMesh(this.track, this.renderer.maxAnisotropy));

    // ---- Fisica ----
    this.vehicle = new Vehicle(car, (i, x, z) => this.groundAt(i, x, z));
    this.applySim();
    this.fitNewTyres();
    this.placeOnGrid(0);

    // ---- Vista, HUD, cronometro ----
    this.view = new CarView(rig, this.vehicle);
    this.cameras = new CameraRig(this.renderer.camera, this.view);
    this.hud = new Hud(this.uiEl);
    // i record valgono per QUESTA geometria: se modifichi la pista ripartono da zero
    this.timer = new LapTimer(this.track.length, `${trackData.id}_${geometryHash(trackData)}`, car.id, (e) => {
      if (e.type === 'invalidated') this.hud.message('Giro non valido: limiti della pista', 2);
      else if (e.type === 'lap') {
        const txt = formatLapTime(e.time);
        this.hud.message(e.best ? `Nuovo record! ${txt}` : e.valid ? `Giro: ${txt}` : `Giro (non valido): ${txt}`, 3);
      }
    });
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
    this.loop.paused = true;
    this.loop.start();

    this.overlay.showStart(trackData.name, car.name, () => {
      this.started = true;
      this.sound.start();
      this.loop.paused = false;
    });
  }

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

  /** Mette l'auto ferma in un posto della griglia di partenza (0 = pole position). */
  private placeOnGrid(slot: number): void {
    const g = this.track.grid[slot];
    if (!g) return this.placeOnTrack(this.track.length - 30);
    // il posto in griglia indica il centro dell'auto; la fisica lavora sul baricentro (quasi lo stesso punto)
    this.vehicle.reset(g.x, g.z, g.heading);
    const idx = this.track.project(g.x, g.z).index;
    this.wheelHints = [idx, idx, idx, idx];
    this.pitHints = [-1, -1, -1, -1];
    this.carHint = idx;
  }

  /** Mette l'auto ferma sulla linea centrale alla distanza s. */
  private placeOnTrack(s: number): void {
    const n = this.track.samples.length;
    const idx = Math.floor((s / this.track.length) * n) % n;
    const smp = this.track.at(idx);
    this.vehicle.reset(smp.x, smp.z, smp.heading);
    this.wheelHints = [idx, idx, idx, idx];
    this.pitHints = [-1, -1, -1, -1];
    this.carHint = idx;
  }

  private fixedUpdate(dt: number): void {
    const input = this.input.read(dt, this.vehicle.speed, this.aids.keyboardSteerAssist);
    this.lastSteer = input.steer;
    this.vehicle.step(dt, input, this.aids);

    const p = this.track.project(this.vehicle.x, this.vehicle.z, this.carHint);
    this.carHint = p.index;
    this.carS = p.s;
    this.carD = p.d;
    const allOff = this.vehicle.surfaces.every((s) => s.name === 'erba');
    this.timer.update(dt, p.s, allOff);

    // Rete di sicurezza: troppo lontani dalla pista → si torna in pista
    if (Math.abs(p.d) > 120) this.resetToTrack();
  }

  private resetToTrack(): void {
    this.placeOnTrack(this.carS);
    this.timer.invalidate();
  }

  private handleActions(): void {
    for (const a of this.input.consumeActions()) {
      if (!this.started) continue;
      switch (a) {
        case 'camera':
          this.hud.message(`Telecamera: ${this.cameras.next()}`, 1);
          break;
        case 'reset':
          this.resetToTrack();
          break;
        case 'pause':
          this.togglePause();
          break;
        case 'help':
          if (!this.loop.paused) this.togglePause();
          break;
        case 'telemetry':
          this.hud.telemetry.classList.toggle('show');
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

  private togglePause(): void {
    if (this.loop.paused) {
      this.overlay.hide();
      this.loop.paused = false;
      this.sound.setPaused(false);
    } else {
      this.loop.paused = true;
      this.sound.setPaused(true);
      this.overlay.showPause(() => this.togglePause(), [
        { label: 'Ricomincia dalla griglia', act: () => { this.placeOnGrid(0); this.timer.reset(); this.togglePause(); } },
        ...(this.fromEditor ? [{ label: "✎ Torna all'editor", act: () => navigate('editor', { pista: this.trackId }) }] : []),
        { label: 'Menu principale', act: () => navigate('menu') },
      ]);
    }
  }

  private render(alpha: number, frameDt: number): void {
    this.handleActions();
    const v = this.vehicle;
    this.view.update(alpha);
    this.cameras.update(frameDt, v.speed);
    this.renderer.followShadows(this.view.position);

    const dt = v.drivetrain;
    this.hud.update({
      speedKmh: v.speed * MS_TO_KMH,
      gear: dt.gear,
      rpm: dt.rpm,
      maxRpm: this.car.maxRpm,
      shifting: dt.isShifting,
      lap: this.timer.lap,
      current: this.timer.current,
      lastLap: this.timer.lastLap,
      bestLap: this.timer.bestLap,
      valid: this.timer.valid,
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
      tyres: v.tires.map((t) => ({
        temp: t.surfaceTemp, core: t.coreTemp, pressure: t.pressure,
        tread: t.tread, grip: t.gripFactor, optimal: t.compound.optimalTemp,
      })),
    }, frameDt);

    const avgT = (a: number, b: number) => (v.tires[a].effectiveTemp + v.tires[b].effectiveTemp) / 2;
    this.graph.push(frameDt, [
      v.speed * MS_TO_KMH, v.appliedThrottle, v.appliedBrake, this.lastSteer,
      v.aLatSmooth / 9.81, avgT(0, 1), avgT(2, 3),
    ]);

    const maxSlip = Math.max(...v.tires.map((t) => t.combinedSlip));
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
