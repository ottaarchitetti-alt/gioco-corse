/**
 * Gestione input: tastiera, gamepad e volante (es. Logitech G29).
 *
 * Tutte le periferiche producono lo stesso oggetto `DriverInput`, che è anche
 * ciò che useranno i bot: la fisica non sa chi la sta guidando.
 *
 * Convenzioni:
 *   steer    ∈ [-1, 1]  +1 = sterzo tutto a SINISTRA, -1 = tutto a destra
 *                       (1 = metà della rotazione massima del volante dell'auto)
 *   throttle ∈ [0, 1]
 *   brake    ∈ [0, 1]
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
export type GameAction = 'camera' | 'reset' | 'pause' | 'help' | 'telemetry' | 'mute' | 'debug';

/** Impostazioni del volante, salvate in locale. Si regolano dal pannello debug (F2). */
export interface WheelSettings {
  steerAxis: number;
  throttleAxis: number;
  brakeAxis: number;
  /** Pedali che a riposo valgono +1 e premuti -1 (tipico del G29). */
  pedalsInverted: boolean;
  invertSteer: boolean;
  /** Gradi di rotazione totale impostati nel driver (G HUB). Il G29 di default è 900°. */
  hardwareLockDeg: number;
  shiftUpButton: number;
  shiftDownButton: number;
  deadzone: number;
}

const DEFAULT_WHEEL: WheelSettings = {
  steerAxis: 0,
  throttleAxis: 2,
  brakeAxis: 3,
  pedalsInverted: true,
  invertSteer: false,
  hardwareLockDeg: 900,
  shiftUpButton: 4, // paletta destra (da verificare sul tuo G29)
  shiftDownButton: 5, // paletta sinistra
  deadzone: 0.01,
};

/** Tasti → azioni di gioco. */
const ACTION_KEYS: Record<string, GameAction> = {
  KeyC: 'camera',
  KeyR: 'reset',
  KeyP: 'pause',
  Escape: 'pause',
  KeyH: 'help',
  KeyT: 'telemetry',
  KeyM: 'mute',
  F2: 'debug',
};

export type InputDevice = 'tastiera' | 'gamepad' | 'volante';

export class InputManager {
  readonly wheel: WheelSettings = loadJSON('wheel', DEFAULT_WHEEL);

  /** Dispositivo usato per ultimo (mostrato nell'HUD). */
  device: InputDevice = 'tastiera';
  /** Ultimi valori grezzi degli assi del gamepad: utili per la calibrazione. */
  rawAxes: number[] = [];
  rawButtons: number[] = [];
  gamepadName = '';
  /** Rotazione totale del volante dell'auto in gradi (dal file .car.json). */
  carSteeringLockDeg = 540;

  private keys = new Set<string>();
  private pendingActions: GameAction[] = [];
  private pendingShiftUp = false;
  private pendingShiftDown = false;
  private prevButtons: boolean[] = [];

  // Stato "morbido" della tastiera: i tasti sono on/off, quindi li trasformiamo in rampe.
  private kbSteer = 0;
  private kbThrottle = 0;
  private kbBrake = 0;
  private lastPadValues: number[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F2' || e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
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
    if (pad) {
      const usingPad = this.detectActivity(pad);
      if (usingPad) this.device = pad.mapping === 'standard' ? 'gamepad' : 'volante';
      if (this.device !== 'tastiera') {
        const v = this.device === 'gamepad' ? this.readStandardPad(pad) : this.readWheel(pad);
        out.steer = v.steer;
        out.throttle = v.throttle;
        out.brake = v.brake;
      }
      this.readShiftButtons(pad);
    }

    out.shiftUp = this.pendingShiftUp;
    out.shiftDown = this.pendingShiftDown;
    this.pendingShiftUp = this.pendingShiftDown = false;
    return out;
  }

  private pollGamepad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (p && p.connected) {
        this.gamepadName = p.id;
        this.rawAxes = Array.from(p.axes);
        this.rawButtons = p.buttons.map((b) => b.value);
        return p;
      }
    }
    this.gamepadName = '';
    return null;
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

  /** Volante: lo sterzo è 1:1 con i gradi reali, i pedali vengono normalizzati. */
  private readWheel(pad: Gamepad) {
    const w = this.wheel;
    let ax = pad.axes[w.steerAxis] ?? 0;
    if (w.invertSteer) ax = -ax;
    if (Math.abs(ax) < w.deadzone) ax = 0;
    // ax = ±1 corrisponde a metà della rotazione hardware (es. ±450° su 900°).
    const steerDeg = -ax * (w.hardwareLockDeg / 2);
    // Il volante dell'auto ruota al massimo di ±carLock/2: oltre quel punto si "tocca il fine corsa".
    return {
      steer: clamp(steerDeg / (this.carSteeringLockDeg / 2), -1, 1),
      throttle: this.pedal(pad.axes[w.throttleAxis]),
      brake: this.pedal(pad.axes[w.brakeAxis]),
    };
  }

  private pedal(v: number | undefined): number {
    if (v === undefined) return 0;
    const p = this.wheel.pedalsInverted ? (1 - v) / 2 : (v + 1) / 2;
    return clamp((p - 0.02) / 0.96, 0, 1);
  }

  private readShiftButtons(pad: Gamepad): void {
    const isWheel = pad.mapping !== 'standard';
    const upIdx = isWheel ? this.wheel.shiftUpButton : 5; // RB
    const downIdx = isWheel ? this.wheel.shiftDownButton : 4; // LB
    const pressed = pad.buttons.map((b) => b.pressed);
    if (pressed[upIdx] && !this.prevButtons[upIdx]) this.pendingShiftUp = true;
    if (pressed[downIdx] && !this.prevButtons[downIdx]) this.pendingShiftDown = true;
    // Gamepad standard: Y = telecamera, Start = pausa, Select = reset
    if (!isWheel) {
      if (pressed[3] && !this.prevButtons[3]) this.pendingActions.push('camera');
      if (pressed[9] && !this.prevButtons[9]) this.pendingActions.push('pause');
      if (pressed[8] && !this.prevButtons[8]) this.pendingActions.push('reset');
    }
    this.prevButtons = pressed;
  }
}
