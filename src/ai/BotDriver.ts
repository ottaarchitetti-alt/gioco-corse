/**
 * PILOTA BOT: guida l'auto con gli STESSI comandi di un umano (sterzo, gas,
 * freno) sulla STESSA fisica. Nessun trucco: se sbaglia, va lungo davvero.
 *
 *  - Sterzo: "pure pursuit" — punta un punto della traiettoria (ideale, o
 *    spostata di lato per sorpassare/difendersi) più avanti, più controsterzo
 *    se l'auto ruota troppo.
 *  - Velocità: segue il profilo di velocità del suo livello, adattato
 *    all'aderenza che "sente" (gomme fredde o usurate → più piano).
 *
 *  CORPO A CORPO (Fase 6)
 *  - Accodamento: non tampona chi gli sta davanti.
 *  - Sorpasso: se è più veloce o bloccato da un po', sceglie il lato con più
 *    spazio (preferendo l'interno della prossima curva), sfrutta la scia e
 *    stacca un filo più tardi; se affiancato lascia spazio; poi rientra.
 *  - Difesa: UNA sola cambiata di traiettoria per coprire l'interno quando
 *    qualcuno lo attacca prima di una curva.
 *  - Bandiere: con la blu (sta per essere doppiato) si sposta e alza il piede;
 *    con la gialla (auto ferma o fuori più avanti) rallenta.
 *
 *  ERRORI (Fase 6)
 *  All'inizio di ogni frenata può sbagliare: frenata lunga, bloccaggio delle
 *  ruote, troppo gas in uscita. Più probabile ai livelli bassi, sotto
 *  pressione, durante un sorpasso, con gomme usurate.
 */
import { clamp, RAD } from '../core/math';
import { emptyInput, type DriverInput } from '../input/InputManager';
import type { Vehicle } from '../physics/Vehicle';
import type { RacingLine } from './RacingLine';

export interface BotSkill {
  /** Frazione dell'aderenza teorica sfruttata */
  grip: number;
  /** Frazione della decelerazione massima usata in frenata */
  brake: number;
  /** Variabilità da un giro all'altro (0 = robot perfetto) */
  inconsistency: number;
  /** Probabilità di errore a ogni frenata (prima dei moltiplicatori) */
  errorRate: number;
  /** Voglia di sorpassare (0..1) */
  aggression: number;
}

/** Livelli di difficoltà */
export const DIFFICULTIES = {
  facile: { label: 'Facile', grip: 0.9, brake: 0.84, inconsistency: 0.02, errorRate: 0.03, aggression: 0.45 },
  medio: { label: 'Medio', grip: 0.96, brake: 0.87, inconsistency: 0.01, errorRate: 0.012, aggression: 0.7 },
  difficile: { label: 'Difficile', grip: 0.99, brake: 0.89, inconsistency: 0.007, errorRate: 0.007, aggression: 0.8 },
  esperto: { label: 'Esperto', grip: 1.01, brake: 0.9, inconsistency: 0.004, errorRate: 0.004, aggression: 0.9 },
} as const;
export type Difficulty = keyof typeof DIFFICULTIES;

/** Cosa sa il bot delle altre auto. */
export interface Traffic {
  /** posizione sulla pista */
  s: number;
  d: number;
  speed: number;
  /** distanza totale percorsa nella sessione (per capire chi è un giro avanti) */
  total: number;
  /** fuori pista (almeno 2 ruote sull'erba) */
  offTrack: boolean;
}

type Mode = 'linea' | 'sorpasso' | 'difesa' | 'cede';
type ErrorType = 'lungo' | 'bloccaggio' | 'gas';

/** Larghezza "di sicurezza" tra due auto affiancate (centro-centro, m) */
const SIDE_GAP = 2.7;

export class BotDriver {
  private profile: Float32Array;
  private steer = 0;
  /** Variazione casuale di questo giro, per ogni "zona" della pista */
  private lapNoise: Float32Array;
  private lastS = 0;
  /** Spostamento laterale dalla traiettoria ideale, attuale e desiderato (m) */
  private lane = 0;
  mode: Mode = 'linea';
  private passSide = 0;
  private passTarget: Traffic | null = null;
  private modeTimer = 0;
  /** Tempo passato dietro la stessa auto */
  private followTime = 0;
  private defendUsed = false;
  private defendSide = 0;
  /** Posizione laterale scelta per difendersi (fissa: una sola mossa) */
  private defendFrom: number | null = null;
  // errori
  private wasBraking = false;
  private errType: ErrorType | null = null;
  private errTimer = 0;
  /** Disattiva l'ABS (bloccaggio): lo legge chi applica gli aiuti */
  absOff = false;
  /** Ultimo errore commesso (per messaggi e test) */
  lastError = '';
  errors = 0;
  /** Tempo da fermo (per capire se è bloccato) */
  stuckTime = 0;
  /** Da quanto l'auto è girata contromano (testacoda) */
  wrongWayTime = 0;
  /** Posizione laterale al passo precedente (per capire se ci si allarga) */
  private prevD: number | null = null;
  /** Gas del passo precedente (il gas si apre in modo progressivo) */
  private lastThrottle = 0;
  /** Migliore aderenza delle gomme vista finora (gomme in temperatura) */
  private feelRef = 0;
  private feelAvg = 0;
  /** Posizione della traiettoria ideale al passo precedente */
  private prevLineD: number | null = null;
  /** Velocità sopra cui si ricarica la batteria col motore termico (km/h) */
  clipKmh = 270;
  /** Gas massimo che le ruote posteriori riescono a scaricare a terra (dosaggio in trazione) */
  private tractionLimit = 1;
  /** Ritirato: accosta fuori dalla pista e si ferma (lo imposta Game) */
  pullOver = false;
  private pullSide = 0;
  /** Neutralizzazione (safety car / VSC): niente sorpassi e velocità ridotta (li imposta Game) */
  noPass = false;
  /** Moltiplicatore della velocità obiettivo (VSC, danni, pista bagnata) */
  paceScale = 1;
  /** Velocità massima (m/s): safety car e VSC */
  speedCap = Infinity;
  /** Bandiere viste in questo passo */
  flags = { yellow: false, blue: false };

  constructor(private line: RacingLine, private vehicle: Vehicle, readonly skill: BotSkill) {
    this.profile = line.speedProfile(vehicle.car, skill.grip, skill.brake);
    this.lapNoise = new Float32Array(32);
    this.newLapNoise();
  }

  private newLapNoise(): void {
    for (let i = 0; i < this.lapNoise.length; i++) this.lapNoise[i] = 1 - Math.random() * this.skill.inconsistency;
  }

  /** Velocità obiettivo all'indice i, con rumore del giro. */
  private target(i: number): number {
    const n = this.line.n;
    const k = ((i % n) + n) % n;
    return this.profile[k] * this.lapNoise[Math.floor((k / n) * this.lapNoise.length)];
  }

  /** Lato interno della prossima curva importante entro `dist` metri: +1 sinistra, −1 destra, 0 nessuna. */
  private nextCornerSide(idx: number, dist: number): number {
    const n = this.line.n, step = this.line.track.length / n;
    let best = 0, sign = 0;
    for (let k = 0; k < dist / step; k += 2) {
      const c = this.line.curvature[(idx + k) % n];
      if (Math.abs(c) > best) { best = Math.abs(c); sign = Math.sign(c); }
    }
    return best > 1 / 400 ? sign : 0;
  }

  /**
   * Decide i comandi per questo passo.
   * @param s, d posizione dell'auto sulla pista
   * @param myTotal distanza totale percorsa nella sessione
   * @param others altre auto (pilota e bot)
   * @param hold true = tieni il freno (es. prima del via)
   */
  drive(dt: number, s: number, d: number, myTotal: number, others: Traffic[], hold: boolean): DriverInput {
    const v = this.vehicle;
    const line = this.line;
    const track = line.track;
    const n = line.n;
    const L = track.length;
    const step = L / n;
    const idx = Math.round(s / step) % n;
    const out = emptyInput();
    this.absOff = false;

    // nuovo giro → nuova variabilità
    if (s < this.lastS - L / 2) this.newLapNoise();
    this.lastS = s;

    if (hold) {
      this.lastThrottle = 1; // partenza: il gas si dà subito (ci pensa la frizione)
      out.brake = 1;
      return out;
    }
    // =================== TESTACODA ===================
    // auto girata rispetto al senso di marcia: niente inseguimento della traiettoria (girerebbe su
    // sé stessa con lo sterzo a fondo). Si ferma dritta e poi viene rimessa in pista (stuckTime).
    const smp = track.samples[idx];
    const headErr = Math.atan2(Math.sin(v.yaw - smp.heading), Math.cos(v.yaw - smp.heading));
    if (Math.abs(headErr) > 75 * RAD) {
      this.steer += clamp(-this.steer, -4 * dt, 4 * dt);
      out.steer = this.steer;
      out.brake = 1;
      this.wrongWayTime += dt;
      // quasi fermo (o girato da troppo): il gioco lo rimette in pista (soglia stuckTime > 4)
      if ((this.wrongWayTime > 1.5 && v.speed < 12) || this.wrongWayTime > 5) this.stuckTime = 5;
      return out;
    }
    this.wrongWayTime = 0;
    if (this.pullOver) return this.driveOff(dt, idx, d);
    const speed = Math.max(v.speed, 1);
    // dove può stare il centro dell'auto: mezza larghezza dell'auto + mezzo metro dal bordo
    const edgeMargin = (v.car.collision?.halfWidth ?? 1.0) + 0.5;
    const halfW = track.samples[idx].width / 2 - edgeMargin;
    const lineD = line.offset[idx];

    // =================== LETTURA DEL TRAFFICO ===================
    let front: (Traffic & { gap: number }) | null = null; // la prima auto davanti sulla mia traiettoria
    let attacker: (Traffic & { gap: number }) | null = null; // chi mi attacca da dietro
    let minD = -halfW, maxD = halfW; // limiti laterali per non stringere chi è affiancato
    let wantAvoid: number | null = null;
    /** affiancato a un'auto un po' più avanti e troppo vicina di lato: cedo (sua velocità) */
    let yieldTo: number | null = null;
    // finestra "affiancati": dipende dalla lunghezza dell'auto (monoposto più lunga della GT)
    const alongside = 2 * (v.car.collision?.halfLength ?? 2.3) + 0.9;
    const myLane = lineD + this.lane;
    this.flags = { yellow: false, blue: false };
    let blueFrom = 0;

    for (const o of others) {
      let gap = o.s - s;
      if (gap < -L / 2) gap += L;
      if (gap > L / 2) gap -= L;

      // bandiera gialla: auto ferma o fuori pista più avanti
      if (gap > 0 && gap < 250 && (o.offTrack || o.speed < 8)) this.flags.yellow = true;
      // bandiera blu: arriva da dietro chi è un giro avanti
      if (gap < 0 && gap > -70 && o.total > myTotal + L * 0.5) {
        this.flags.blue = true;
        blueFrom = o.d;
      }

      // affiancati: lascio spazio
      if (Math.abs(gap) < alongside) {
        if (o.d > d) maxD = Math.min(maxD, o.d - SIDE_GAP);
        else minD = Math.max(minD, o.d + SIDE_GAP);
        if (gap > 0.8 && Math.abs(o.d - d) < SIDE_GAP - 0.2) yieldTo = Math.min(yieldTo ?? Infinity, o.speed);
        continue;
      }
      // dietro: possibile attaccante
      if (gap < 0) {
        if (gap > -18 && o.speed > v.speed - 1 && (!attacker || gap > attacker.gap)) attacker = { ...o, gap };
        continue;
      }
      if (gap > 60 + speed * 1.2) continue;
      // è sulla mia traiettoria? (in sorpasso conta solo dove sono adesso, non dove andrò)
      const inPath = Math.abs(o.d - d) <= 2.3 || (this.mode !== 'sorpasso' && Math.abs(o.d - myLane) <= 2.3);
      if (!inPath) continue;
      // auto ferma o lentissima: si aggira dal lato con più spazio
      if (o.speed < 4 && gap < 45) {
        const left = halfW - o.d, right = o.d + halfW;
        wantAvoid = left > right ? Math.min(halfW, o.d + 3.2) : Math.max(-halfW, o.d - 3.2);
        continue;
      }
      if (!front || gap < front.gap) front = { ...o, gap };
    }

    // =================== DECISIONI ===================
    this.modeTimer += dt;
    // si sta per frenare (o si sta già frenando) per una curva
    const brakingZone = this.target(idx + Math.round(60 / step)) < v.speed * 0.9;
    let laneAbs = lineD; // posizione laterale desiderata (assoluta)
    if (front && front.gap < 30) this.followTime += dt;
    else this.followTime = 0;

    if (this.flags.blue) {
      // lascia passare: verso il lato opposto a chi arriva
      this.mode = 'cede';
      laneAbs = clamp(blueFrom >= d ? d - SIDE_GAP : d + SIDE_GAP, -halfW, halfW);
    } else {
      if (this.mode === 'cede') this.mode = 'linea';

      // ---- inizio sorpasso ----
      // un sorpasso si prepara in rettilineo: non si butta dentro in frenata da lontano
      if (this.noPass && this.mode === 'sorpasso') { this.mode = 'linea'; this.passTarget = null; }
      if (this.mode !== 'sorpasso' && front && front.gap < 28 && !brakingZone && !this.noPass) {
        const faster = v.speed > front.speed + 1.5 || this.target(idx) > front.speed + 2.5;
        const stuck = this.followTime > 3 - this.skill.aggression * 1.5;
        if ((faster || stuck) && Math.random() < 0.2 + this.skill.aggression * 0.5) {
          const inside = this.nextCornerSide(idx, 220);
          const roomL = halfW - (front.d + SIDE_GAP), roomR = (front.d - SIDE_GAP) + halfW;
          let side = 0;
          if (inside !== 0 && (inside > 0 ? roomL : roomR) >= 0) side = inside;
          else if (roomL >= 0 || roomR >= 0) side = roomL > roomR ? 1 : -1;
          if (side !== 0) {
            this.mode = 'sorpasso';
            this.passSide = side;
            this.passTarget = front;
            this.modeTimer = 0;
          }
        }
      }

      if (this.mode === 'sorpasso') {
        // ritrova l'auto da passare (la più vicina con stessa posizione approssimata)
        let tgt: (Traffic & { gap: number }) | null = null;
        for (const o of others) {
          let gap = o.s - s;
          if (gap < -L / 2) gap += L;
          if (gap > L / 2) gap -= L;
          if (gap > -15 && gap < 40 && (!tgt || Math.abs(o.d - this.passTarget!.d) < Math.abs(tgt.d - this.passTarget!.d))) tgt = { ...o, gap };
        }
        if (!tgt || tgt.gap < -9 || this.modeTimer > 9) {
          // lo sorpassato non è più tra i "vicini": si rientra solo se la linea è libera
          this.mode = 'linea'; // passato (o rinuncia): si rientra in traiettoria
          this.passTarget = null;
        } else {
          this.passTarget = tgt;
          // in sorpasso un po' di margine in più dal bordo (si è affiancati e al limite)
          laneAbs = clamp(tgt.d + this.passSide * (SIDE_GAP + 0.4), -halfW + 0.6, halfW - 0.6);
          // non c'è più spazio da quel lato: rinuncia
          if (Math.abs(laneAbs - tgt.d) < SIDE_GAP - 0.3) this.mode = 'linea';
          // all'inizio della frenata bisogna essere almeno quasi affiancati, altrimenti si
          // rinuncia e ci si rimette in coda (come un pilota vero: niente "siluri" da lontano)
          if (brakingZone && tgt.gap > alongside * 0.6) { this.mode = 'linea'; this.passTarget = null; }
        }
      } else if (this.mode === 'difesa') {
        // si copre il lato senza chiudere: resta almeno una macchina di spazio verso il bordo
        laneAbs = clamp(d + this.defendSide * 2.2, -halfW + SIDE_GAP * 0.5, halfW - SIDE_GAP * 0.5);
        if (this.defendFrom === null) this.defendFrom = laneAbs;
        laneAbs = this.defendFrom; // una sola mossa: la posizione scelta non cambia più
        if (this.modeTimer > 5 || !attacker) { this.mode = 'linea'; this.defendFrom = null; }
      } else {
        // ---- difesa: UNA sola mossa, regolare ----
        // chi attacca esce dalla scia da un lato: il bot copre quel lato (in rettilineo) o
        // l'interno della prossima curva, se è lo stesso lato. Regole (come in F1):
        //  - un solo cambio di direzione per difendersi (defendUsed), poi resta lì;
        //  - mai in frenata (niente mosse mentre si stacca);
        //  - mai se l'attaccante è già affiancato (lì si lascia una macchina di spazio, vedi sopra);
        //  - si sposta di poco (copre la linea, non chiude contro l'erba).
        if (attacker && !this.noPass && !this.defendUsed && !brakingZone && attacker.gap > -25 && attacker.gap < -alongside
          && Math.abs(attacker.d - d) > 1.0) {
          const inside = this.nextCornerSide(idx, 300);
          const attackSide = Math.sign(attacker.d - d);
          if ((inside === 0 || attackSide === inside) && Math.random() < this.skill.aggression * 0.08) {
            this.mode = 'difesa';
            this.defendSide = attackSide;
            this.defendUsed = true;
            this.modeTimer = 0;
          }
        }
      }
      if (!attacker || attacker.gap < -30) this.defendUsed = false;
    }

    if (wantAvoid !== null) laneAbs = wantAvoid;
    laneAbs = clamp(laneAbs, minD, Math.max(minD, maxD));
    // la traiettoria cambia gradualmente (3 m/s di spostamento laterale)
    const onLine = Math.abs(this.lane) < 0.5;
    const prevAbs = this.prevLineD === null ? null : this.prevLineD + this.lane;
    this.prevLineD = lineD;
    this.lane += clamp(laneAbs - lineD - this.lane, -3 * dt, 3 * dt);
    if (this.mode === 'linea' && wantAvoid === null) this.lane += clamp(-this.lane, -1.5 * dt, 1.5 * dt);
    // Lo spostamento è relativo alla traiettoria. Dove questa attraversa la carreggiata (curve
    // veloci) uno spostamento relativo trascinerebbe l'auto verso il bordo più in fretta di quanto
    // possa seguirlo: fuori traiettoria la posizione mirata si sposta verso il bordo al massimo di
    // 3 m/s (verso il centro, liberamente).
    if (!onLine && prevAbs !== null) {
      const abs = lineD + this.lane;
      const maxOut = Math.abs(prevAbs) + 3 * dt;
      if (Math.abs(abs) > maxOut && Math.abs(abs) > 2) this.lane = Math.sign(abs) * maxOut - lineD;
    }
    // e comunque traiettoria + spostamento sempre dentro la carreggiata
    this.lane = clamp(this.lane, -halfW - lineD, halfW - lineD);

    // =================== STERZO (pure pursuit) ===================
    const look = 5 + speed * 0.42; // metri
    const ti = (idx + Math.round(look / step)) % n;
    const ts = track.samples[ti];
    // il punto mirato resta dentro la carreggiata anche se lì la traiettoria è già vicina al bordo
    const tHalf = ts.width / 2 - edgeMargin - 0.3; // un filo di margine: l'auto oscilla attorno al punto
    // Lo spostamento `lane` è relativo alla traiettoria. Se è grande (sorpasso, difesa) conta la
    // posizione reale in pista: dove la traiettoria attraversa la carreggiata, seguirla porterebbe
    // il punto mirato sul bordo. Man mano che lo spostamento si riduce si torna sulla traiettoria.
    const follow = clamp(1 - Math.abs(this.lane) / 4, 0, 1);
    const tLat = clamp(lineD + this.lane + (line.offset[ti] - lineD) * follow, -tHalf, tHalf);
    const tx = ts.x + ts.nx * tLat - v.x, tz = ts.z + ts.nz * tLat - v.z;
    const sinY = Math.sin(v.yaw), cosY = Math.cos(v.yaw);
    const lz = tx * sinY + tz * cosY; // avanti
    const lx = tx * cosY - tz * sinY; // sinistra
    const alpha = Math.atan2(lx, Math.max(0.1, lz));
    const ld = Math.hypot(lx, lz);
    const curv = (2 * Math.sin(alpha)) / Math.max(ld, 1);
    let delta = Math.atan(v.car.wheelbase * curv);
    const yawErr = v.yawRate - speed * curv;
    delta -= 0.16 * yawErr; // l'auto ruota più del previsto → controsterzo
    const beta = Math.atan2(v.vLat, Math.max(3, v.vLong));
    const sliding = Math.abs(beta) > 4 * RAD && v.speed > 8;
    if (sliding) delta += beta * 0.6;
    // correzione dell'errore laterale rispetto alla traiettoria (più forte a bassa velocità, dove
    // il punto mirato è vicino e un metro di errore conta di più)
    const kCross = 0.012 * clamp(30 / Math.max(speed, 10), 0.35, 1.5);
    delta += clamp((clamp(lineD + this.lane, -halfW, halfW) - d) * kCross, -0.04, 0.04) * (v.speed > 5 ? 1 : 0);
    // al bordo della carreggiata (es. gomme fredde, uscita di curva in accelerazione): sterza
    // verso l'interno. Interviene già un po' prima del limite se l'auto si sta allargando.
    const edgeOver = Math.abs(d) - halfW;
    const dRate = this.prevD === null ? 0 : clamp((d - this.prevD) / dt, -20, 20);
    this.prevD = d;
    // Ci si avvicina al bordo con velocità laterale `out`: per fermarla prima del limite serve
    // un'accelerazione laterale out²/(2·spazio) → curvatura in più = a / v² (come farebbe un pilota)
    const outward = Math.sign(d) * dRate;
    const room = Math.max(0.25, halfW + 0.3 - Math.abs(d));
    const drifting = outward > 0.3 && edgeOver > -2.5 && v.speed > 5;
    if (drifting) {
      const kNeed = (outward * outward) / (2 * room) / Math.max(speed * speed, 25);
      delta -= Math.sign(d) * Math.min(0.08, Math.atan(v.car.wheelbase * kNeed) * 1.2);
    }
    if (edgeOver > 0 && v.speed > 5) delta -= Math.sign(d) * Math.min(0.04, 0.01 + edgeOver * 0.03);
    const maxDelta = ((v.car.steeringLockDeg / 2) / v.car.steeringRatio) * RAD;
    // niente sterzo oltre quello che le gomme possono dare: alla velocità attuale la curva più
    // stretta possibile ha curvatura a_max / v² (aderenza + deportanza). Sterzare di più a
    // 150 km/h (es. all'uscita di una curva con l'auto un po' storta) fa solo girare l'auto.
    if (v.speed > 12) {
      const aMax = v.car.tire.mu * (9.81 + v.downforceN / v.car.mass) * 1.05;
      const kMax = aMax / (v.speed * v.speed);
      // + angolo di deriva utile delle gomme; in derapata il controsterzo può crescere quanto serve
      const deltaLim = Math.atan(v.car.wheelbase * kMax) + 0.07 + (sliding ? Math.abs(beta) : 0);
      delta = clamp(delta, -deltaLim, deltaLim);
    }
    const rate = 4 * dt;
    this.steer += clamp(clamp(delta / maxDelta, -1, 1) - this.steer, -rate, rate);
    out.steer = this.steer;

    // =================== VELOCITÀ ===================
    // poco anticipo: il profilo contiene già i punti di frenata (serve solo a coprire il ritardo
    // con cui freni e gas agiscono)
    const ahead = (idx + Math.round((speed * 0.1) / step)) % n;
    // aderenza "sentita" rispetto alla migliore vista finora (gomme in temperatura): il profilo
    // vale per gomme calde, si rallenta solo se le gomme rendono meno di così (fredde, usurate)
    const feel = v.tires.reduce((a, t) => a + t.gripFactor, 0) / 4;
    // (media su qualche secondo: un valore isolato, es. il primo passo, non fa da riferimento).
    // All'inizio il riferimento è quello tipico di gomme in temperatura (~93% della mescola):
    // così con le gomme fredde del primo giro il bot sa di dover andare più piano.
    if (this.feelRef === 0) this.feelRef = this.feelAvg = v.tires[0].compound.muMul * 0.93;
    this.feelAvg += (feel - this.feelAvg) * Math.min(1, dt / 3);
    this.feelRef = Math.max(this.feelRef, this.feelAvg);
    let vt = Math.min(this.target(ahead), this.target(idx) + 3) * Math.sqrt(Math.min(1, feel / this.feelRef));
    // fuori traiettoria il raggio cambia: all'interno di una curva è più stretto (in un tornante
    // anche della metà) → velocità limite = v·√(R'/R), e bisogna frenare in tempo per arrivarci
    // (conta dove l'auto è davvero, se è più lontana dalla traiettoria di quanto voluto: es. finita
    // larga in frenata)
    // (tolleranza di 1 m: i piccoli scostamenti di guida non contano)
    const dev = d - lineD - this.lane;
    const off = this.lane + (Math.abs(dev) > 1 ? dev - Math.sign(dev) : 0);
    if (Math.abs(off) > 0.3) {
      const brakeAcc = 11; // m/s², prudente (vale per GT e monoposto)
      const look = Math.round(Math.max(40, speed * 1.6) / step);
      for (let j = 0; j <= look; j += 2) {
        const kj = line.curvature[(idx + j) % n];
        if (Math.abs(kj) < 1 / 400) continue;
        const R = 1 / Math.abs(kj);
        const inside = off * Math.sign(kj); // + = verso l'interno della curva
        const f = inside > 0 ? Math.sqrt(Math.max(0.3, (R - inside) / R)) : 1 - 0.03 * Math.min(1, -inside / 3);
        if (f >= 1) continue;
        const vj = this.target(idx + j) * f;
        vt = Math.min(vt, Math.sqrt(vj * vj + 2 * brakeAcc * j * step));
      }
    }
    // in sorpasso si stacca un filo più tardi (e si rischia di più)
    if (this.mode === 'sorpasso' && !brakingZone) vt *= 1 + 0.02 * this.skill.aggression;
    vt = Math.min(vt * this.paceScale, this.speedCap);
    if (this.flags.yellow) vt *= 0.93;
    if (this.flags.blue) vt *= 0.95;
    if (wantAvoid !== null) vt = Math.min(vt, 22);
    // prima curva del via: tutti in gruppo, si frena un po' prima
    if (myTotal < 1500) vt *= 0.96;
    // ruote vicine a quelle di chi è affiancato e un po' davanti: alzo il piede e lo lascio andare
    if (yieldTo !== null) vt = Math.min(vt, yieldTo * 0.97);

    // accodamento: velocità che permette di fermarsi dietro chi è davanti
    if (front && wantAvoid === null) {
      // in coda dietro la safety car (o in VSC) si lascia più spazio: il gruppo rallenta a fisarmonica
      const safe = this.noPass ? 9 + speed * 0.45 : 5.5 + speed * 0.35;
      const closing = Math.sqrt(Math.max(0, front.speed * front.speed + 2 * 7 * Math.max(0, front.gap - safe)));
      vt = Math.min(vt, closing, front.gap < safe ? front.speed * 0.9 : Infinity);
    }

    // =================== ERRORI ===================
    // inizio di una frenata: la velocità obiettivo 50 m più avanti è nettamente più bassa
    const braking = this.target(idx + Math.round(50 / step)) < v.speed * 0.88;
    if (braking && !this.wasBraking && this.errType === null) this.rollError(attacker !== null);
    this.wasBraking = braking;
    if (this.errType === 'lungo') vt *= 1.09; // ha frenato tardi: entra troppo forte

    const err = vt - v.speed;
    // come un pilota vero: gas a fondo finché si è sotto la velocità obiettivo (il gas parziale
    // tiene chiuse le ali attive e toglie la spinta elettrica), freno deciso quando si è sopra
    if (err > 0) {
      out.throttle = clamp(err * 1.5 + 0.45, 0, 1);
      out.brake = 0;
    } else {
      out.throttle = err > -0.6 ? clamp(0.35 + err * 0.5, 0, 1) : 0;
      out.brake = err < -0.6 ? clamp(-err * 0.6, 0, 1) : 0;
    }
    if (this.errType === 'bloccaggio') {
      // pestone sul freno senza ABS: le ruote si bloccano, l'auto non curva
      out.brake = 1;
      out.throttle = 0;
      this.absOff = true;
    }
    if (this.errType === 'gas' && !braking) out.throttle = 1; // troppo gas in uscita
    if (this.errType !== null) {
      this.errTimer -= dt;
      if (this.errTimer <= 0) this.errType = null;
    }

    // al bordo (o quasi, allargandosi): si alza il piede, senza frenare (frenare mentre si sterza
    // toglie aderenza all'avantreno e l'auto va ancora più larga)
    if (edgeOver > 0 || (drifting && edgeOver > -0.5)) {
      out.throttle = Math.min(out.throttle, edgeOver > 0 ? 0.2 : 0.45);
      if (!braking) out.brake = Math.min(out.brake, 0.15);
    }
    // il posteriore parte: via dal freno e gas dolce per ritrovare aderenza (come un pilota)
    if (sliding) {
      // in frenata per una curva però il freno non si molla (si arriverebbe lunghi, a muro):
      // si alleggerisce e l'ABS tiene le ruote al limite; mollarlo del tutto solo se gira davvero
      out.brake = Math.min(out.brake, braking && Math.abs(beta) < 9 * RAD ? 0.55 : 0.1);
      out.throttle = Math.min(out.throttle, 0.25);
    }

    // gas progressivo, come un pilota: niente "on/off" (nelle marce basse, con tanta coppia,
    // un colpo di gas in curva fa partire il posteriore)
    const rise = (v.drivetrain.gear <= 2 ? 2.5 : 4) * dt;
    out.throttle = Math.min(out.throttle, this.lastThrottle + rise);
    // dosaggio del gas in trazione (come un pilota, non a scatti come il controllo di trazione):
    // si cerca lo slittamento delle ruote posteriori che dà la massima spinta, poco sotto il picco
    const rearSlip = Math.max(v.tires[2].kappa, v.tires[3].kappa) / v.car.tire.peakSlipRatio;
    if (rearSlip > 0.8 && v.speed > 3) this.tractionLimit -= Math.min(1, rearSlip - 0.8) * 30 * dt;
    else this.tractionLimit += 1.2 * dt;
    this.tractionLimit = clamp(this.tractionLimit, 0.15, 1);
    out.throttle = Math.min(out.throttle, this.tractionLimit);
    this.lastThrottle = out.throttle;
    // spinta elettrica solo dove serve davvero: non in prima/seconda né quando le ruote
    // posteriori già slittano (l'energia andrebbe in fumo), così la batteria dura per i rettilinei
    v.hybrid.deployScale = v.drivetrain.gear >= 3 && this.tractionLimit > 0.97 ? 1 : 0;
    // ad alta velocità la spinta elettrica rende poco (e oltre ~290 km/h il regolamento la
    // riduce): lì si ricarica col motore termico ("super clipping") per spingere dopo, in uscita
    // dalle curve, dove ogni kJ fa guadagnare molto di più
    if (v.hybrid.hasErs && !v.hybrid.overtakeActive) {
      v.hybrid.mode = v.speed * 3.6 > this.clipKmh && v.hybrid.charge < 0.95 ? 'ricarica' : 'bilanciata';
    }

    this.stuckTime = v.speed < 1.5 ? this.stuckTime + dt : 0;
    return out;
  }

  /**
   * Auto ritirata: accosta fuori dalla carreggiata (dal lato dove si trova) frenando con calma,
   * poi si ferma lì; i commissari la portano via (lo decide Game).
   */
  private driveOff(dt: number, idx: number, d: number): DriverInput {
    const v = this.vehicle, track = this.line.track, n = this.line.n;
    const out = emptyInput();
    if (this.pullSide === 0) this.pullSide = d >= 0 ? 1 : -1;
    const step = track.length / n;
    const ti = (idx + Math.round((8 + v.speed * 0.6) / step)) % n;
    const ts = track.samples[ti];
    const lat = this.pullSide * (ts.width / 2 + 3);
    const tx = ts.x + ts.nx * lat - v.x, tz = ts.z + ts.nz * lat - v.z;
    const sinY = Math.sin(v.yaw), cosY = Math.cos(v.yaw);
    const lz = tx * sinY + tz * cosY, lx = tx * cosY - tz * sinY;
    const curv = (2 * Math.sin(Math.atan2(lx, Math.max(0.1, lz)))) / Math.max(Math.hypot(lx, lz), 1);
    const maxDelta = ((v.car.steeringLockDeg / 2) / v.car.steeringRatio) * RAD;
    const want = v.speed < 0.5 ? 0 : clamp(Math.atan(v.car.wheelbase * curv) / maxDelta, -0.6, 0.6);
    this.steer += clamp(want - this.steer, -3 * dt, 3 * dt);
    out.steer = this.steer;
    out.throttle = 0;
    out.brake = v.speed > 30 ? 0.25 : v.speed > 3 ? 0.45 : 1;
    this.stuckTime = 0;
    return out;
  }

  /** Tira i dadi all'inizio di una frenata. */
  private rollError(underPressure: boolean): void {
    const tread = this.vehicle.tires.reduce((a, t) => a + t.tread, 0) / 4;
    let p = this.skill.errorRate;
    if (underPressure) p *= 2;
    if (this.mode === 'sorpasso') p *= 1.5;
    p *= 1 + 2 * (1 - tread);
    if (Math.random() >= p) return;
    const r = Math.random();
    this.errType = r < 0.45 ? 'lungo' : r < 0.75 ? 'bloccaggio' : 'gas';
    this.errTimer = this.errType === 'lungo' ? 2.2 : this.errType === 'bloccaggio' ? 0.45 : 3.0;
    this.lastError = { lungo: 'frenata lunga', bloccaggio: 'bloccaggio', gas: 'troppo gas in uscita' }[this.errType];
    this.errors++;
  }
}
