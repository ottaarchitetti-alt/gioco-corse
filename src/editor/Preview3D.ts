/**
 * Anteprima 3D della pista dall'editor: la stessa mesh che userà il gioco,
 * da girare con il mouse (sinistro = ruota, destro = sposta, rotellina = zoom).
 */
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Renderer } from '../render/Renderer';
import { buildTrackMesh } from '../track/TrackMeshBuilder';
import type { TrackSpline } from '../track/TrackSpline';

export class Preview3D {
  private el: HTMLDivElement;
  private renderer: Renderer;
  private controls: OrbitControls;
  private running = true;

  constructor(track: TrackSpline, private onClose: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'ed-preview';
    document.body.appendChild(this.el);
    this.renderer = new Renderer(this.el);
    const r = this.renderer;
    r.scene.add(buildTrackMesh(track, r.maxAnisotropy));

    // Inquadratura iniziale: dall'alto in diagonale, puntando al centro della pista
    const xs = track.samples.map((s) => s.x), zs = track.samples.map((s) => s.z);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    r.camera.position.set(cx + span * 0.35, span * 0.45, cz + span * 0.6);
    this.controls = new OrbitControls(r.camera, r.renderer.domElement);
    this.controls.target.set(cx, 0, cz);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03; // mai sotto il terreno
    this.controls.enableDamping = true;
    this.controls.update();

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = `<button class="primary">✕ Chiudi anteprima</button><button data-a="start">Vai alla partenza</button>
      <span>Sinistro: ruota · Destro: sposta · Rotellina: zoom · Esc: chiudi</span>`;
    this.el.appendChild(bar);
    bar.querySelector('button.primary')!.addEventListener('click', () => this.close());
    bar.querySelector('[data-a="start"]')!.addEventListener('click', () => {
      const s = track.grid[0] ?? track.samples[0];
      this.controls.target.set(s.x, 0, s.z);
      r.camera.position.set(s.x - Math.sin(s.heading) * 25, 10, s.z - Math.cos(s.heading) * 25);
    });
    window.addEventListener('keydown', this.onKey);

    const loop = () => {
      if (!this.running) return;
      this.controls.update();
      r.followShadows(this.controls.target);
      r.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.code === 'Escape') this.close();
    e.stopPropagation();
  };

  close(): void {
    this.running = false;
    window.removeEventListener('keydown', this.onKey);
    this.controls.dispose();
    this.renderer.dispose();
    this.el.remove();
    this.onClose();
  }
}
