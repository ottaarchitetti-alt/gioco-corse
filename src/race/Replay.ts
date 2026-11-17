/**
 * REPLAY della sessione.
 *
 * Registrazione: 20 volte al secondo salviamo posizione, direzione, sterzo e
 * velocità di ogni auto (pochi MB anche per gare lunghe con 20 auto).
 * Riproduzione: le auto vengono messe nelle posizioni registrate (interpolate),
 * con comandi play/pausa, velocità, barra del tempo, auto da seguire e
 * telecamere: inseguimento, cofano, abitacolo oppure TV (camere fisse a bordo
 * pista che zoomano sull'auto, come in televisione).
 */
import * as THREE from 'three';
import type { Vehicle } from '../physics/Vehicle';
import type { CameraRig } from '../render/CameraRig';
import type { CarView } from '../render/CarView';
import type { TrackSpline } from '../track/TrackSpline';

const RATE = 20;
/** valori per auto in ogni fotogramma: x, z, yaw, sterzo, velocità */
const STRIDE = 5;

export interface ReplayCar {
  name: string;
  vehicle: Vehicle;
  view: CarView;
}

export class ReplayRecorder {
  frames: Float32Array[] = [];
  private acc = 0;

  reset(): void {
    this.frames = [];
    this.acc = 0;
  }

  get duration(): number {
    return Math.max(0, (this.frames.length - 1) / RATE);
  }

  record(dt: number, cars: ReplayCar[]): void {
    this.acc += dt;
    if (this.acc < 1 / RATE && this.frames.length) return;
    this.acc = 0;
    const f = new Float32Array(cars.length * STRIDE);
    cars.forEach((c, i) => {
      const v = c.vehicle;
      f.set([v.x, v.z, v.yaw, v.steerAngle, v.speed], i * STRIDE);
    });
    this.frames.push(f);
  }
}

type ReplayCam = 'tv' | 'esterna' | 'cofano' | 'abitacolo';

export class ReplayPlayer {
  t = 0;
  speed = 1;
  playing = true;
  follow = 0;
  cam: ReplayCam = 'tv';
  private el: HTMLDivElement;
  private tvCams: THREE.Vector3[] = [];
  private slider!: HTMLInputElement;
  private timeLabel!: HTMLSpanElement;

  constructor(
    private rec: ReplayRecorder,
    private cars: ReplayCar[],
    private rig: CameraRig,
    private camera: THREE.PerspectiveCamera,
    track: TrackSpline,
    private onExit: () => void,
    followIndex = 0,
  ) {
    this.follow = followIndex;
    // camere TV ogni ~220 m, all'esterno della curva, a 20 m dal bordo e 7 m di altezza
    const n = track.samples.length;
    const every = Math.max(1, Math.round(220 / (track.length / n)));
    for (let i = 0; i < n; i += every) {
      const s = track.samples[i];
      const side = s.curvature > 0 ? -1 : 1; // esterno curva
      const off = s.width / 2 + 20;
      this.tvCams.push(new THREE.Vector3(s.x + s.nx * off * side, 7, s.z + s.nz * off * side));
    }
    this.el = document.createElement('div');
    this.el.className = 'replay-bar';
    document.body.appendChild(this.el);
    document.body.classList.add('replay-mode');
    this.renderUi();
  }

  private renderUi(): void {
    const dur = this.rec.duration;
    this.el.innerHTML = `
      <span class="rtitle">🎬 REPLAY</span>
      <button data-a="back">⏪ 10 s</button>
      <button data-a="play">${this.playing ? '⏸' : '▶'}</button>
      <button data-a="fwd">10 s ⏩</button>
      <input type="range" min="0" max="${dur}" step="0.05" value="${this.t}">
      <span class="rtime mono"></span>
      <select data-a="speed">${[0.25, 0.5, 1, 2, 4].map((s) => `<option value="${s}" ${s === this.speed ? 'selected' : ''}>${s}×</option>`).join('')}</select>
      <select data-a="follow">${this.cars.map((c, i) => `<option value="${i}" ${i === this.follow ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
      <select data-a="cam">${(['tv', 'esterna', 'cofano', 'abitacolo'] as ReplayCam[]).map((c) => `<option value="${c}" ${c === this.cam ? 'selected' : ''}>${c === 'tv' ? 'Camere TV' : c}</option>`).join('')}</select>
      <button class="primary" data-a="exit">Esci</button>`;
    this.slider = this.el.querySelector('input[type=range]')!;
    this.timeLabel = this.el.querySelector('.rtime')!;
    this.slider.addEventListener('input', () => { this.t = parseFloat(this.slider.value); });
    const q = (a: string) => this.el.querySelector(`[data-a="${a}"]`)!;
    q('play').addEventListener('click', () => { this.playing = !this.playing; this.renderUi(); });
    q('back').addEventListener('click', () => { this.t = Math.max(0, this.t - 10); });
    q('fwd').addEventListener('click', () => { this.t = Math.min(dur, this.t + 10); });
    q('exit').addEventListener('click', () => this.exit());
    (q('speed') as HTMLSelectElement).addEventListener('change', (e) => { this.speed = parseFloat((e.target as HTMLSelectElement).value); });
    (q('follow') as HTMLSelectElement).addEventListener('change', (e) => { this.follow = parseInt((e.target as HTMLSelectElement).value); });
    (q('cam') as HTMLSelectElement).addEventListener('change', (e) => { this.cam = (e.target as HTMLSelectElement).value as ReplayCam; });
  }

  exit(): void {
    this.el.remove();
    document.body.classList.remove('replay-mode');
    this.onExit();
  }

  /** Da chiamare a ogni frame grafico al posto della simulazione. */
  update(frameDt: number): void {
    const frames = this.rec.frames;
    if (!frames.length) return;
    const dur = this.rec.duration;
    if (this.playing) this.t = Math.min(dur, this.t + frameDt * this.speed);
    if (this.t >= dur) this.playing = false;
    this.slider.value = String(this.t);
    const fmt = (x: number) => `${Math.floor(x / 60)}:${(x % 60).toFixed(1).padStart(4, '0')}`;
    this.timeLabel.textContent = `${fmt(this.t)} / ${fmt(dur)}`;

    // posizioni interpolate tra due fotogrammi
    const k = this.t * RATE;
    const i0 = Math.min(frames.length - 1, Math.floor(k)), i1 = Math.min(frames.length - 1, i0 + 1);
    const f = k - i0;
    const a = frames[i0], b = frames[i1];
    this.cars.forEach((c, i) => {
      if (i * STRIDE >= a.length) return;
      const o = i * STRIDE;
      const v = c.vehicle;
      let dy = b[o + 2] - a[o + 2];
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      v.x = v.prevX = a[o] + (b[o] - a[o]) * f;
      v.z = v.prevZ = a[o + 1] + (b[o + 1] - a[o + 1]) * f;
      v.yaw = v.prevYaw = a[o + 2] + dy * f;
      v.steerAngle = a[o + 3] + (b[o + 3] - a[o + 3]) * f;
      const sp = a[o + 4] + (b[o + 4] - a[o + 4]) * f;
      v.speed = sp;
      // ruote che girano e carrozzeria ferma sulle sospensioni
      for (const t of v.tires) t.spin += (sp / v.car.wheelRadius) * frameDt * this.speed * (this.playing ? 1 : 0);
      v.suspension.reset();
      c.view.update(1);
    });

    // telecamera
    const target = this.cars[this.follow].view;
    if (this.cam === 'tv') {
      const p = target.position;
      let best = this.tvCams[0], bd = Infinity;
      for (const cpos of this.tvCams) {
        const d = cpos.distanceToSquared(p);
        if (d < bd) { bd = d; best = cpos; }
      }
      this.camera.position.copy(best);
      this.camera.lookAt(p.x, 0.8, p.z);
      // zoom: l'auto occupa più o meno la stessa porzione d'inquadratura
      const fov = THREE.MathUtils.clamp((2 * Math.atan(9 / Math.sqrt(bd)) * 180) / Math.PI, 6, 60);
      if (Math.abs(this.camera.fov - fov) > 0.1) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
    } else {
      this.rig.view = target;
      this.rig.mode = this.cam;
      this.rig.update(frameDt, this.cars[this.follow].vehicle.speed);
    }
  }
}
