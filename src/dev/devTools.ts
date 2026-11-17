/**
 * Strumenti di SVILUPPO (caricati solo con `npm run dev`, mai nella versione finale).
 *
 * Dalla console del browser (F12):
 *   devTools.autopilot(5)            → 5 giri con un pilota automatico rudimentale,
 *                                      simulati alla massima velocità (non in tempo reale),
 *                                      stampa tempi, temperature, pressioni e usura a ogni giro
 *   devTools.autopilot(5, { latG: 1.2 })  → pilota più prudente
 *
 * Serve per tarare la fisica in modo ripetibile. NON è l'IA dei bot (Fase 5),
 * anche se ne anticipa l'idea: segue la linea centrale e frena in base alla curvatura.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export function installDevTools(game: any): void {
  const autopilot = (laps: number, opts: { latG?: number } = {}): string => {
    const g = game;
    const v = g.vehicle;
    const tr = g.track;
    const dt = g.loop.fixedDt;
    const n = tr.samples.length;
    const latG = opts.latG ?? 1.3;

    const cmd = { steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false };
    const origRead = g.input.read.bind(g.input);
    const origMsg = g.hud.message.bind(g.hud);
    g.input.read = () => ({ ...cmd });
    g.hud.message = () => {};

    const lines: string[] = [];
    g.placeOnTrack(tr.length - 30);
    g.timer.reset();
    let lastLap = 0;
    let simT = 0;
    try {
      while (g.timer.lap <= laps && simT < laps * 200) {
        const p = tr.project(v.x, v.z, g.carHint);
        // Sterzo: punta un punto della linea centrale più avanti con la velocità
        const look = Math.round((6 + v.speed * 0.45) / (tr.length / n));
        const tgt = tr.at(p.index + look);
        const ang = Math.atan2(tgt.x - v.x, tgt.z - v.z) - v.yaw;
        const a = Math.atan2(Math.sin(ang), Math.cos(ang));
        const maxWheel = ((v.car.steeringLockDeg / 2) * Math.PI) / 180;
        cmd.steer = Math.max(-1, Math.min(1, (a * 1.5 * v.car.steeringRatio) / maxWheel));
        // Velocità: limite di curva nei prossimi ~180 m, con spazio di frenata
        let vmax = 95;
        for (let k = 0; k < 90; k += 3) {
          const c = Math.abs(tr.at(p.index + k).curvature);
          const lim = Math.sqrt((latG * 9.81) / Math.max(c, 1e-4));
          vmax = Math.min(vmax, Math.sqrt(lim * lim + 2 * 11 * ((k * tr.length) / n)));
        }
        const err = vmax - v.speed;
        cmd.throttle = err > 0 ? Math.min(1, err * 0.4) : 0;
        cmd.brake = err < -0.5 ? Math.min(1, -err * 0.25) : 0;

        g.fixedUpdate(dt);
        simT += dt;
        if (g.timer.lap !== lastLap) {
          lastLap = g.timer.lap;
          const t = v.tires as any[];
          const f = (fn: (x: any) => string) => t.map(fn).join('/');
          lines.push(
            `giro ${lastLap - 1}: ${g.timer.lastLap?.toFixed(2) ?? '-'}s` +
              `  Tsup ${f((x) => x.surfaceTemp.toFixed(0))}  Tcarc ${f((x) => x.coreTemp.toFixed(0))}` +
              `  p ${f((x) => x.pressure.toFixed(2))}  batt ${f((x) => (x.tread * 100).toFixed(1))}` +
              `  grip ${f((x) => (x.gripFactor * 100).toFixed(0))}`,
          );
        }
      }
    } finally {
      g.input.read = origRead;
      g.hud.message = origMsg;
      g.placeOnTrack(tr.length - 30);
      g.timer.reset();
    }
    return lines.join('\n');
  };

  (window as any).devTools = { autopilot };
}
