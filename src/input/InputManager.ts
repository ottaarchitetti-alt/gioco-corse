/**
 * Gestione input: tastiera, gamepad e volante (es. Logitech G29).
 *
 * Tutte le periferiche producono lo stesso oggetto `DriverInput`, che è anche
 * ciò che usano i bot: la fisica non sa chi la sta guidando.
 *
 * Convenzioni:
 *   steer    ∈ [-1, 1]  +1 = sterzo tutto a SINISTRA, -1 = tutto a destra
 *                       (1 = metà della rotazione massima del volante dell'auto)
 *   throttle ∈ [0, 1]
 *   brake    ∈ [0, 1]
 *
 * VOLANTE: assi, pedali e palette si configurano con la CALIBRAZIONE GUIDATA
 * (WheelCalibration.ts), che misura i valori reali del tuo volante: niente
 * da indovinare su assi o pedali "invertiti".
 */
import { clamp, moveTowards } from '../core/math';
import { loadJSON, saveJSON } from '../core/storage';

export interface DriverInput {
  steer: number;
  throttle: number;
  brake: number;
  /** true solo nel passo in cui il comando viene premuto */
  shiftUp: boolean;
  shiftDown: boolean;
}

export const emptyInput = (): DriverInput => ({
  steer: 0, throttle: 0, brake: 0, shiftUp: false, shiftDown: false,
});

/** Azioni "di gioco" (non di guida) che scattano una volta per pressione. */
export type GameAction = 'camera' | 'reset' | 'pause' | 'help' | 'telemetry' | 'graphs' | 'laps' | 'ghost' | 'mute' | 'debug' | 'overtake' | 'ersMode' | 'flashback';

/** Un pedale calibrato: su quale asse sta e quanto vale a riposo e a fondo corsa. */
export interface PedalCalibration {
  axis: number;
  rest: number;
  full: number;
}

/**
 * Come si trasforma la rotazione del volante in sterzo:
 *  - 'reale':   1:1 — il volante dell'auto ruota quanto il tuo (consigliato:
 *               imposta in G HUB la stessa rotazione dell'auto, 540° per la GT)
 *  - 'scalato': tutta la corsa del tuo volante = tutta la corsa del volante dell'auto
 */
export type SteerMode = 'reale' | 'scalato';

/** Impostazioni del volante, salvate in locale. */
export interface WheelSettings {
  /** id del dispositivo calibrato (es. "Logitech G29 Driving Force Racing Wheel ...") */
  deviceId: string;
  calibrated: boolean;
  steerAxis: number;
  /** valore grezzo dell'asse con il volante dritto */
  steerCenter: number;
  invertSteer: boolean;
  /** Gradi di rotazione totale del volante fisico (misurati in calibrazione). */
  hardwareLockDeg: number;
  steerMode: SteerMode;
  /** 1 = lineare; >1 = meno sensibile al centro, più ai lati */
  steerLinearity: number;
  /** zona morta al centro (gradi) */
  steerDeadzoneDeg: number;
  throttle: PedalCalibration;
  brake: PedalCalibration;
  /** zona morta dei pedali (frazione di corsa) */
  pedalDeadzone: number;
  shiftUpButton: number;
  shiftDownButton: number;
  /** Pulsanti della monoposto: Overtake mode e modalità della batteria (-1 = nessuno) */
  overtakeButton: number;
  ersModeButton: number;
  /** Flashback: torna indietro di qualche secondo (-1 = nessuno) */
  flashbackButton: number;
}

const DEFAULT_WHEEL: WheelSettings = {
  deviceId: '',
  calibrated: false,
  steerAxis: 0,
  steerCenter: 0,
  invertSteer: false,
  hardwareLockDeg: 900,
  steerMode: 'reale',
  steerLinearity: 1,
  steerDeadzoneDeg: 0.5,
  // valori tipici del G29 su Windows: pedali a riposo +1, premuti −1
  throttle: { axis: 2, rest: 1, full: -1 },
  brake: { axis: 5, rest: 1, full: -1 },
  pedalDeadzone: 0.03,
  shiftUpButton: 4, // paletta destra
  shiftDownButton: 5, // paletta sinistra
  overtakeButton: 0, // G29: tasto X
  ersModeButton: 2, // G29: tasto cerchio
  flashbackButton: 1, // G29: tasto quadrato
};

/** Converte le impostazioni salvate dalle versioni precedenti (Fasi 1–4). */
function migrateWheel(raw: Record<string, unknown>): WheelSettings {
  const w = { ...DEFAULT_WHEEL, ...raw } as WheelSettings & { throttleAxis?: number; brakeAxis?: number; pedalsInverted?: boolean };
  if (typeof w.throttleAxis === 'number' && !raw.throttle) {
    const inv = w.pedalsInverted !== false;
    w.throttle = { axis: w.throttleAxis, rest: inv ? 1 : -1, full: inv ? -1 : 1 };
    w.brake = { axis: w.brakeAxis ?? 3, rest: inv ? 1 : -1, full: inv ? -1 : 1 };
  }
  delete w.throttleAxis;
  delete w.brakeAxis;
  delete w.pedalsInverted;
  return w;
}

/** Tasti → azioni di gioco. */
const ACTION_KEYS: Record<string, GameAction> = {
  KeyC: 'camera',
  KeyR: 'reset',
  KeyP: 'pause',
  Escape: 'pause',
  KeyH: 'help',
  KeyT: 'telemetry',
  KeyG: 'graphs',
  KeyL: 'laps',
  KeyF: 'ghost',
  KeyM: 'mute',
  F2: 'debug',
  KeyO: 'overtake',
  KeyK: 'ersMode',
  Backspace: 'flashback',
};

export type InputDevice = 'tastiera' | 'gamepad' | 'volante';

/** Parole che fanno riconoscere un volante dal nome del dispositivo */
const WHEEL_WORDS = /wheel|g29|g920|g923|g27|g25|driving force|logitech|thrustmaster|fanatec|moza|simagic/i;

export class InputManager {
  readonly wheel: WheelSettings = migrateWheel(loadJSON<Record<string, unknown>>('wheel', {}));

  /** Dispositivo usato per ultimo (mostrato nell'HUD). */
  device: InputDevice = 'tastiera';
  /** Ultimi valori grezzi degli assi del gamepad: utili per la calibrazione. */
  rawAxes: number[] = [];
  rawButtons: number[] = [];
  gamepadName = '';
  /** Rotazione totale del volante dell'auto in gradi (dal file .car.json). */
  carSteeringLockDeg = 540;
  /** Se true la lettura del volante è sospesa (durante la calibrazione). */
  suspended = false;

  private keys = new Set<string>();
  private pendingActions: GameAction[] = [];
  private pendingShiftUp = false;
  private pendingShiftDown = false;
  private prevButtons: boolean[] = [];
  /**
   * Chrome riporta 0 per un asse finché non lo muovi la prima volta: un pedale
   * a riposo che dovrebbe valere +1 sembrerebbe "premuto a metà".
   * Ricordiamo quali assi hanno già dato un valore vero.
   */
  private axisSeen = new Set<number>();

  // Stato "morbido" della tastiera: i tasti sono on/off, quindi li trasformiamo in rampe.
  private kbSteer = 0;
  private kbThrottle = 0;
  private kbBrake = 0;
  private lastPadValues: number[] = [];
  private lastPadId = '';

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F2' || e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Backspace') e.preventDefault();
      if (!e.repeat) {
        const action = ACTION_KEYS[e.code];
        if (action) this.pendingActions.push(action);
        if (e.code === 'KeyE' || e.code === 'ShiftLeft') this.pendingShiftUp = true;
        if (e.code === 'KeyQ' || e.code === 'ControlLeft') this.pendingShiftDown = true;
      }
      this.keys.add(e.code);
      this.device = 'tastiera';
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  saveWheelSettings(): void {
    saveJSON('wheel', this.wheel);
  }

  /** Restituisce e svuota le azioni di gioco premute dall'ultimo frame. */
  consumeActions(): GameAction[] {
    const a = this.pendingActions;
    this.pendingActions = [];
    return a;
  }

  /** Tutti i dispositivi collegati. */
  listPads(): Gamepad[] {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return Array.from(pads).filter((p): p is Gamepad => !!p && p.connected);
  }

  /** È un volante? (calibrato come tale, oppure dal nome) */
  isWheel(pad: Gamepad): boolean {
    return (this.wheel.calibrated && pad.id === this.wheel.deviceId) || WHEEL_WORDS.test(pad.id) || pad.mapping !== 'standard';
  }

  /**
   * Legge tutte le periferiche e restituisce l'input di guida.
   * Va chiamato a ogni passo fisico.
   * @param speedMs velocità dell'auto: serve per lo sterzo assistito da tastiera.
   * @param keyboardSteerAssist riduce lo sterzo massimo da tastiera ad alta velocità.
   */
  read(dt: number, speedMs: number, keyboardSteerAssist: boolean): DriverInput {
    const out = emptyInput();

    // ---------- Tastiera ----------
    const left = this.keys.has('ArrowLeft') || this.keys.has('KeyA');
    const right = this.keys.has('ArrowRight') || this.keys.has('KeyD');
    const up = this.keys.has('ArrowUp') || this.keys.has('KeyW');
    const down = this.keys.has('ArrowDown') || this.keys.has('KeyS') || this.keys.has('Space');

    // Sterzo massimo da tastiera: a 0 km/h tutto, a 200 km/h circa un quarto.
    const steerLimit = keyboardSteerAssist ? 1 / (1 + speedMs / 18) : 1;
    const steerTarget = (left ? 1 : 0) - (right ? 1 : 0);
    // Più veloci a tornare al centro che ad andare a fondo corsa.
    const steerRate = steerTarget === 0 || Math.sign(steerTarget) !== Math.sign(this.kbSteer) ? 4.0 : 2.2;
    this.kbSteer = moveTowards(this.kbSteer, steerTarget * steerLimit, steerRate * dt);
    this.kbThrottle = moveTowards(this.kbThrottle, up ? 1 : 0, (up ? 5 : 10) * dt);
    this.kbBrake = moveTowards(this.kbBrake, down ? 1 : 0, (down ? 6 : 10) * dt);

    out.steer = this.kbSteer;
    out.throttle = this.kbThrottle;
    out.brake = this.kbBrake;

    // ---------- Gamepad / volante ----------
    const pad = this.pollGamepad();
    if (pad && !this.suspended) {
      const wheel = this.isWheel(pad);
      if (this.detectActivity(pad)) this.device = wheel ? 'volante' : 'gamepad';
      if (this.device !== 'tastiera') {
        const v = wheel ? this.readWheel(pad) : this.readStandardPad(pad);
        out.steer = v.steer;
        out.throttle = v.throttle;
        out.brake = v.brake;
      }
      this.readShiftButtons(pad, wheel);
    }

    out.shiftUp = this.pendingShiftUp;
    out.shiftDown = this.pendingShiftDown;
    this.pendingShiftUp = this.pendingShiftDown = false;
    return out;
  }

  /** Sceglie il dispositivo: quello calibrato, altrimenti un volante, altrimenti il primo. */
  private pollGamepad(): Gamepad | null {
    const pads = this.listPads();
    const pad =
      pads.find((p) => this.wheel.calibrated && p.id === this.wheel.deviceId) ??
      pads.find((p) => WHEEL_WORDS.test(p.id)) ??
      pads[0] ?? null;
    if (!pad) {
      this.gamepadName = '';
      return null;
    }
    if (pad.id !== this.lastPadId) {
      this.lastPadId = pad.id;
      this.axisSeen.clear();
      this.lastPadValues = [];
    }
    this.gamepadName = pad.id;
    this.rawAxes = Array.from(pad.axes);
    this.rawButtons = pad.buttons.map((b) => b.value);
    pad.axes.forEach((a, i) => { if (a !== 0) this.axisSeen.add(i); });
    return pad;
  }

  /** Passa al gamepad/volante appena qualcosa si muove in modo significativo. */
  private detectActivity(pad: Gamepad): boolean {
    const values = [...pad.axes, ...pad.buttons.map((b) => b.value)];
    let moved = false;
    if (this.lastPadValues.length === values.length) {
      for (let i = 0; i < values.length; i++) {
        if (Math.abs(values[i] - this.lastPadValues[i]) > 0.08) moved = true;
      }
    }
    this.lastPadValues = values;
    return moved;
  }

  /** Gamepad con mappatura standard (Xbox/PlayStation). */
  private readStandardPad(pad: Gamepad) {
    const ax = pad.axes[0] ?? 0;
    const dz = 0.08;
    const s = Math.abs(ax) < dz ? 0 : (ax - Math.sign(ax) * dz) / (1 - dz);
    // Curva leggermente progressiva per più precisione al centro.
    const steer = -Math.sign(s) * Math.pow(Math.abs(s), 1.5);
    return {
      steer,
      throttle: pad.buttons[7]?.value ?? 0, // grilletto destro
      brake: pad.buttons[6]?.value ?? 0, // grilletto sinistro
    };
  }

  /** Gradi di rotazione del volante fisico (+ = a sinistra), dal valore grezzo dell'asse. */
  wheelDegrees(raw: number): number {
    const w = this.wheel;
    // asse ±1 = metà della rotazione totale
    let deg = (raw - w.steerCenter) * (w.hardwareLockDeg / 2);
    if (!w.invertSteer) deg = -deg; // sul G29 l'asse è negativo a sinistra
    return deg;
  }

  /** Sterzo [-1,1] per l'auto dai gradi del volante fisico. */
  steerFromDegrees(deg: number): number {
    const w = this.wheel;
    const half = this.carSteeringLockDeg / 2;
    if (Math.abs(deg) < w.steerDeadzoneDeg) deg = 0;
    else deg -= Math.sign(deg) * w.steerDeadzoneDeg;
    let x = w.steerMode === 'reale'
      ? deg / half // 1:1 con il volante dell'auto
      : deg / (w.hardwareLockDeg / 2); // corsa intera → corsa intera
    x = clamp(x, -1, 1);
    if (w.steerLinearity !== 1) x = Math.sign(x) * Math.pow(Math.abs(x), w.steerLinearity);
    return x;
  }

  /** Valore 0..1 di un pedale calibrato. */
  pedalValue(p: PedalCalibration, raw: number | undefined): number {
    if (raw === undefined) return 0;
    // asse mai mosso e riportato a 0 da Chrome, ma il riposo vero è lontano da 0: è a riposo
    if (raw === 0 && !this.axisSeen.has(p.axis) && Math.abs(p.rest) > 0.5) return 0;
    const span = p.full - p.rest;
    if (Math.abs(span) < 0.05) return 0;
    const v = (raw - p.rest) / span;
    const dz = this.wheel.pedalDeadzone;
    return clamp((v - dz) / (1 - dz * 2), 0, 1);
  }

  /** Volante: lo sterzo è 1:1 con i gradi reali, i pedali vengono normalizzati. */
  private readWheel(pad: Gamepad) {
    const w = this.wheel;
    return {
      steer: this.steerFromDegrees(this.wheelDegrees(pad.axes[w.steerAxis] ?? w.steerCenter)),
      throttle: this.pedalValue(w.throttle, pad.axes[w.throttle.axis]),
      brake: this.pedalValue(w.brake, pad.axes[w.brake.axis]),
    };
  }

  private readShiftButtons(pad: Gamepad, isWheel: boolean): void {
    const upIdx = isWheel ? this.wheel.shiftUpButton : 5; // RB
    const downIdx = isWheel ? this.wheel.shiftDownButton : 4; // LB
    const pressed = pad.buttons.map((b) => b.pressed);
    if (!this.suspended) {
      if (pressed[upIdx] && !this.prevButtons[upIdx]) this.pendingShiftUp = true;
      if (pressed[downIdx] && !this.prevButtons[downIdx]) this.pendingShiftDown = true;
      // Gamepad standard: Y = telecamera, Start = pausa, Select = reset
      const edge = (i: number) => i >= 0 && pressed[i] && !this.prevButtons[i];
      if (isWheel) {
        if (edge(this.wheel.overtakeButton)) this.pendingActions.push('overtake');
        if (edge(this.wheel.ersModeButton)) this.pendingActions.push('ersMode');
        if (edge(this.wheel.flashbackButton)) this.pendingActions.push('flashback');
      } else {
        // gamepad: X = Overtake mode, B = modalità batteria
        if (edge(2)) this.pendingActions.push('overtake');
        if (edge(1)) this.pendingActions.push('ersMode');
        if (edge(0)) this.pendingActions.push('flashback'); // A
      }
      if (!isWheel) {
        if (pressed[3] && !this.prevButtons[3]) this.pendingActions.push('camera');
        if (pressed[9] && !this.prevButtons[9]) this.pendingActions.push('pause');
        if (pressed[8] && !this.prevButtons[8]) this.pendingActions.push('reset');
      }
    }
    this.prevButtons = pressed;
  }
}
