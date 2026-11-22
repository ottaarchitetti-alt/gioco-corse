/**
 * Strumenti di SVILUPPO (caricati solo con `npm run dev`, mai nella versione finale).
 *
 * Dalla console del browser (F12):
 *   devTools.autopilot(5)            → 5 giri con un pilota automatico rudimentale,
 *                                      simulati alla massima velocità (non in tempo reale),
 *                                      stampa tempi, temperature, pressioni e usura a ogni giro
 *   devTools.autopilot(5, { latG: 1.2 })  → pilota più prudente
 *   opzioni: records (i giri valgono come record), session (config sessione), keepSession
 *
 * Serve per tarare la fisica in modo ripetibile. NON è l'IA dei bot (Fase 5),
 * anche se ne anticipa l'idea: segue la linea centrale e frena in base alla curvatura.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export function installDevTools(game: any): void {
  const autopilot = (laps: number, opts: { latG?: number; records?: boolean; session?: any; keepSession?: boolean } = {}): string => {
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
    g.recordsEnabled = !!opts.records; // di norma i giri del pilota automatico non sono record

    const lines: string[] = [];
    const prevCfg = { ...g.sessionCfg };
    g.startSession(opts.session ?? { ...g.sessionCfg, type: 'libere', minutes: 0, laps: 5, opponents: 0 }, false);
    if (!opts.session) {
      g.placeOnTrack(g.playerEntity, tr.length - 30);
      g.player.timing.resetPosition();
    }
    const timing = () => g.player.timing;
    let lastLap = 0;
    let simT = 0;
    try {
      while (timing().lap <= laps && simT < laps * 200 && g.session.state !== 'finita') {
        const p = tr.project(v.x, v.z, g.playerEntity.hint);
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
        if (g.session.state === 'semaforo') { cmd.throttle = 0; cmd.brake = 1; } // fermo fino al via

        g.fixedUpdate(dt);
        simT += dt;
        if (timing().lap !== lastLap) {
          lastLap = timing().lap;
          const last = timing().laps[timing().laps.length - 1];
          const t = v.tires as any[];
          const f = (fn: (x: any) => string) => t.map(fn).join('/');
          lines.push(
            `giro ${lastLap - 1}: ${last ? last.time.toFixed(2) + 's' + (last.valid ? '' : ' (non valido)') + ' settori ' + last.sectors.map((x: number | null) => x?.toFixed(2)).join('/') : '-'}` +
              `  Tsup ${f((x) => x.surfaceTemp.toFixed(0))}  Tcarc ${f((x) => x.coreTemp.toFixed(0))}` +
              `  p ${f((x) => x.pressure.toFixed(2))}  batt ${f((x) => (x.tread * 100).toFixed(1))}` +
              `  grip ${f((x) => (x.gripFactor * 100).toFixed(0))}`,
          );
        }
      }
    } finally {
      g.input.read = origRead;
      g.hud.message = origMsg;
      g.recordsEnabled = true;
      if (!opts.keepSession) g.startSession(prevCfg, false);
    }
    return lines.join('\n');
  };

  /**
   * Simula una sessione con bot (senza disegnare) e riporta i loro tempi.
   * Il pilota resta fermo ai box/fuori traiettoria.
   *   devTools.bots(3, { opponents: 5, difficulty: 'esperto' })
   */
  const bots = (laps: number, opts: { opponents?: number; difficulty?: string; type?: string } = {}): string => {
    const g = game;
    const prevCfg = { ...g.sessionCfg };
    const origRead = g.input.read.bind(g.input);
    g.input.read = () => ({ steer: 0, throttle: 0, brake: 1, shiftUp: false, shiftDown: false });
    g.hud.message = () => {};
    g.recordsEnabled = false;
    g.startSession({ ...g.sessionCfg, type: opts.type ?? 'libere', minutes: 0, laps, opponents: opts.opponents ?? 5, difficulty: opts.difficulty ?? 'medio' }, false);
    // il pilota esce di scena (lontano dalla pista) per non intralciare
    g.playerEntity.vehicle.reset(100000, 100000, 0);
    const dt = g.loop.fixedDt;
    let t = 0, resets = 0;
    const origReset = g.resetToTrack.bind(g);
    // il pilota (fuori scena) non va rimesso in pista
    g.resetToTrack = (e: any) => { if (e.isPlayer) return; resets++; origReset(e); };
    const botsE = g.entities.filter((e: any) => !e.isPlayer);
    // sorpassi: cambi di posizione tra bot, contati ogni 3 secondi dopo il via (niente scambi momentanei)
    let overtakes = 0, prevOrder: string[] = [];
    const contacts0 = g.contactCount;
    try {
      let acc = 0;
      while (t < laps * 120 && botsE.some((e: any) => e.competitor.lapsDone < laps) && g.session.state !== 'finita') {
        g.fixedUpdate(dt);
        t += dt;
        acc += dt;
        if (acc > 3 && g.session.state === 'corsa') {
          acc = 0;
          const order = g.session.standings().filter((c: any) => !c.isPlayer).map((c: any) => c.id);
          if (prevOrder.length && t > 15) order.forEach((id: string, i: number) => { if (prevOrder.indexOf(id) > i) overtakes++; });
          prevOrder = order;
        }
      }
    } finally {
      g.input.read = origRead;
      g.resetToTrack = origReset;
      g.recordsEnabled = true;
    }
    const lines = botsE.map((e: any) => {
      const laps2 = e.competitor.timing.laps.map((l: any) => l.time.toFixed(2) + (l.valid ? '' : '*')).join(' ');
      return `${String(e.competitor.position).padStart(2)}. ${e.name.padEnd(14)} grip ${e.bot.skill.grip.toFixed(3)} errori ${e.bot.errors} giri: ${laps2}`;
    });
    const out = [`simulati ${t.toFixed(0)} s, riposizionamenti bot: ${resets}, sorpassi: ${overtakes}, contatti: ${g.contactCount - contacts0}  (* = giro non valido)`, ...lines].join('\n');
    g.startSession(prevCfg, false);
    return out;
  };

  /**
   * Incidenti dei bot in gara: per ogni bot il primo momento in cui perde il controllo
   * (deriva > 15°) o mette due ruote sull'erba, più riposizionamenti e contatti.
   *   devTools.incidenti(4)          → 4 gare da 100 s con 7 bot "esperto"
   */
  const incidenti = (runs = 3, opts: { seconds?: number; opponents?: number; difficulty?: string } = {}) => {
    const g = game;
    const prevCfg = { ...g.sessionCfg };
    const origRead = g.input.read.bind(g.input);
    const origReset = g.resetToTrack.bind(g);
    g.input.read = () => ({ steer: 0, throttle: 0, brake: 1, shiftUp: false, shiftDown: false });
    const origMsg = g.hud.message;
    g.hud.message = () => {};
    g.recordsEnabled = false;
    const out: { resets: number; contacts: number; incidents: string[] }[] = [];
    try {
      for (let run = 0; run < runs; run++) {
        g.startSession({ ...g.sessionCfg, type: 'gara', minutes: 0, laps: 3, opponents: opts.opponents ?? 7, difficulty: opts.difficulty ?? 'esperto' }, false);
        g.playerEntity.vehicle.reset(100000, 100000, 0);
        const botsE = g.entities.filter((e: any) => !e.isPlayer);
        const step = g.track.length / g.line.n;
        const first = new Map<any, string>();
        let resets = 0;
        g.resetToTrack = (e: any) => { if (e.isPlayer) return; resets++; origReset(e); };
        const c0 = g.contactCount;
        let t = 0;
        while (t < (opts.seconds ?? 100) && g.session.state !== 'finita') {
          g.fixedUpdate(g.loop.fixedDt);
          t += g.loop.fixedDt;
          for (const b of botsE) {
            if (first.has(b)) continue;
            const v = b.vehicle;
            const slip = Math.abs(Math.atan2(v.vLat, Math.abs(v.vLong) + 0.01)) * 57.3;
            const grass = v.surfaces.filter((x: any) => x.name === 'erba').length;
            if ((slip > 15 && v.speed > 12) || (grass >= 2 && v.speed > 25)) {
              const i = Math.round(b.s / step) % g.line.n;
              first.set(b, `${t.toFixed(1)}s ${b.name} s=${b.s.toFixed(0)} d=${b.d.toFixed(1)} linea=${g.line.offset[i].toFixed(1)} ` +
                `${(v.speed * 3.6).toFixed(0)}/${(b.bot.profile[i] * 3.6).toFixed(0)} km/h deriva=${slip.toFixed(0)}° erba=${grass} ${b.bot.mode}`);
            }
          }
        }
        out.push({ resets, contacts: g.contactCount - c0, incidents: [...first.values()] });
      }
    } finally {
      g.input.read = origRead;
      g.resetToTrack = origReset;
      g.hud.message = origMsg;
      g.recordsEnabled = true;
      g.startSession(prevCfg, false);
    }
    return out;
  };

  (window as any).devTools = { autopilot, bots, incidenti };
}
