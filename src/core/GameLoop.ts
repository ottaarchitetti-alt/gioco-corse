/**
 * Game loop a PASSO FISSO.
 *
 * La fisica avanza sempre con lo stesso dt (es. 1/240 s), indipendentemente
 * dal frame rate dello schermo. Così la guida è identica su PC lenti e veloci
 * e la simulazione resta stabile.
 *
 * Ogni frame:
 *   1. accumuliamo il tempo reale trascorso;
 *   2. eseguiamo tanti passi fisici quanti ne "stanno" nell'accumulatore;
 *   3. disegniamo interpolando tra l'ultimo e il penultimo stato fisico
 *      (alpha = frazione di passo rimasta), per un movimento fluido.
 */
export interface LoopCallbacks {
  /** Un passo di simulazione di durata fissa `dt`. */
  fixedUpdate(dt: number): void;
  /** Un frame grafico. `alpha` ∈ [0,1) per l'interpolazione, `frameDt` = tempo reale del frame. */
  render(alpha: number, frameDt: number): void;
}

export class GameLoop {
  readonly fixedDt: number;
  /** Se un frame dura troppo (tab in background) non recuperiamo all'infinito. */
  private readonly maxStepsPerFrame = 12;
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  /** Se true la fisica è ferma ma si continua a disegnare (pausa). */
  paused = false;

  constructor(private callbacks: LoopCallbacks, physicsHz = 240) {
    this.fixedDt = 1 / physicsHz;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    let frameDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (frameDt > 0.25) frameDt = 0.25; // es. ritorno da un'altra scheda

    if (!this.paused) {
      this.accumulator += frameDt;
      let steps = 0;
      while (this.accumulator >= this.fixedDt && steps < this.maxStepsPerFrame) {
        this.callbacks.fixedUpdate(this.fixedDt);
        this.accumulator -= this.fixedDt;
        steps++;
      }
      if (steps === this.maxStepsPerFrame) this.accumulator = 0;
    }

    this.callbacks.render(this.paused ? 1 : this.accumulator / this.fixedDt, frameDt);
    requestAnimationFrame(this.frame);
  };
}
