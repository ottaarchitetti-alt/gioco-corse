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
import { Vehicle, type DrivingAids, type Surface } from '../physics/Vehicle';
import { LapTimer } from '../race/LapTimer';
import { loadCarRig } from '../render/AssetManager';
import { CameraRig } from '../render/CameraRig';
import { CarView } from '../render/CarView';
import { Renderer } from '../render/Renderer';
import { loadTrack } from '../track/TrackData';
import { buildTrackMesh } from '../track/TrackMeshBuilder';
import { KERB_WIDTH, TrackSpline } from '../track/TrackSpline';
import { DebugPanel } from '../ui/DebugPanel';
import { Hud } from '../ui/Hud';
import { Overlay } from '../ui/Overlay';

const CAR_URL = 'cars/gt_segnaposto.car.json';
const TRACK_URL = 'tracks/anello_prova.track.json';

/** Superfici (Fase 7/8: valori diversi con pioggia, sporco, gomma depositata). */
const SURFACES: Record<Surface['name'], Surface> = {
  asfalto: { name: 'asfalto', grip: 1, drag: 0 },
  cordolo: { name: 'cordolo', grip: 0.93, drag: 0.005 },
  erba: { name: 'erba', grip: 0.55, drag: 0.06 },
};

const DEFAULT_AIDS: DrivingAids = { abs: true, tc: true, autoShift: true, keyboardSteerAssist: true };

export class Game {
  private renderer!: Renderer;
  private input = new InputManager();
  private sound = new EngineSound();
  private aids: DrivingAids = loadJSON('aids', DEFAULT_AIDS);
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
  private carHint = -1;
  private carS = 0;
  private carD = 0;
  private telemetryTimer = 0;
  private lastSteer = 0;
  private started = false;

  constructor(private appEl: HTMLElement, private uiEl: HTMLElement) {}

  async init(): Promise<void> {
    this.overlay = new Overlay(this.uiEl);
    this.renderer = new Renderer(this.appEl);

    // ---- Dati ----
    const [car, trackData] = await Promise.all([loadCar(CAR_URL), loadTrack(TRACK_URL)]);
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
    this.vehicle = new Vehicle(car, (i, x, z) => this.surfaceAt(i, x, z));
    this.placeOnTrack(this.track.length - 30);

    // ---- Vista, HUD, cronometro ----
    this.view = new CarView(rig, this.vehicle);
    this.cameras = new CameraRig(this.renderer.camera, this.view);
    this.hud = new Hud(this.uiEl);
    this.timer = new LapTimer(this.track.length, trackData.id, car.id, (e) => {
      if (e.type === 'invalidated') this.hud.message('Giro non valido: limiti della pista', 2);
      else if (e.type === 'lap') {
        const txt = formatLapTime(e.time);
        this.hud.message(e.best ? `Nuovo record! ${txt}` : e.valid ? `Giro: ${txt}` : `Giro (non valido): ${txt}`, 3);
      }
    });
    this.debug = new DebugPanel(car, this.aids, () => saveJSON('aids', this.aids), this.input, this.sound);

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

  /** Superficie sotto una ruota: asfalto, cordolo o erba, in base alla distanza dal centro pista. */
  private surfaceAt(i: number, x: number, z: number): Surface {
    const p = this.track.project(x, z, this.wheelHints[i]);
    this.wheelHints[i] = p.index;
    const half = p.sample.width / 2;
    const ad = Math.abs(p.d);
    if (ad <= half) return SURFACES.asfalto;
    const hasKerb = p.d > 0 ? p.sample.kerbLeft : p.sample.kerbRight;
    if (hasKerb && ad <= half + KERB_WIDTH) return SURFACES.cordolo;
    return SURFACES.erba;
  }

  /** Mette l'auto ferma sulla linea centrale alla distanza s. */
  private placeOnTrack(s: number): void {
    const n = this.track.samples.length;
    const idx = Math.floor((s / this.track.length) * n) % n;
    const smp = this.track.at(idx);
    this.vehicle.reset(smp.x, smp.z, smp.heading);
    this.wheelHints = [idx, idx, idx, idx];
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
      this.overlay.showPause(() => this.togglePause());
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
    }, frameDt);

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
      ``,
      `Acc. long ${(v.aLong / g).toFixed(2)} g   lat ${(v.aLat / g).toFixed(2)} g`,
      `Imbardata ${((v.yawRate * 180) / Math.PI).toFixed(1)} °/s   v.lat ${v.vLat.toFixed(2)} m/s`,
      `Coppia motore ${v.drivetrain.engineTorque.toFixed(0)} Nm${v.drivetrain.clutchSlipping ? '  (frizione)' : ''}`,
      `Pista s ${this.carS.toFixed(0)} / ${this.track.length.toFixed(0)} m   d ${this.carD.toFixed(1)} m`,
    ].join('\n');
  }
}
