/**
 * Pannello di regolazione (F2), basato su lil-gui.
 * Serve per tarare la fisica IN TEMPO REALE mentre guidi, e per
 * configurare il volante. I valori dell'auto modificati qui valgono per la
 * sessione; con "Esporta auto" scarichi il JSON da copiare in public/cars.
 * (Dalla Fase 7 l'assetto avrà un vero menu nel gioco.)
 */
import GUI from 'lil-gui';
import type { InputManager } from '../input/InputManager';
import type { CarParams } from '../physics/CarParams';
import type { DrivingAids } from '../physics/Vehicle';

/** Impostazioni di simulazione (ambiente e regole), salvate in locale. */
export interface SimSettings {
  airTemp: number;
  trackTemp: number;
  /** Moltiplicatore usura gomme (1 = realistico) */
  wearMultiplier: number;
  /** Termocoperte: le gomme partono già calde */
  tyreBlankets: boolean;
}

export interface DebugCallbacks {
  onAidsChange: () => void;
  onSimChange: () => void;
  /** Monta gomme nuove con mescola e pressioni dell'assetto */
  onNewTyres: () => void;
}

export class DebugPanel {
  readonly gui: GUI;
  private live = { assi: '', pulsanti: '', periferica: '' };

  constructor(
    car: CarParams,
    aids: DrivingAids,
    sim: SimSettings,
    cb: DebugCallbacks,
    private input: InputManager,
    audio: { volume: number; setVolume: (v: number) => void },
  ) {
    this.gui = new GUI({ title: 'Regolazioni (F2)', width: 340 });
    this.gui.hide();

    const fa = this.gui.addFolder('Aiuti alla guida');
    fa.add(aids, 'abs').name('ABS').onChange(cb.onAidsChange);
    fa.add(aids, 'tc').name('Controllo trazione').onChange(cb.onAidsChange);
    fa.add(aids, 'autoShift').name('Cambio automatico').onChange(cb.onAidsChange);
    fa.add(aids, 'keyboardSteerAssist').name('Sterzo assistito (tastiera)').onChange(cb.onAidsChange);

    // ---- Gomme e assetto gomme ----
    const fg = this.gui.addFolder('Gomme (assetto)');
    const compounds = Object.fromEntries(Object.entries(car.tire.compounds).map(([id, c]) => [c.name, id]));
    fg.add(car.setup, 'compound', compounds).name('Mescola');
    fg.add(car.setup, 'pressureFront', 1.0, 2.2, 0.01).name('Pressione ant. a freddo (bar)');
    fg.add(car.setup, 'pressureRear', 1.0, 2.2, 0.01).name('Pressione post. a freddo (bar)');
    fg.add({ monta: cb.onNewTyres }, 'monta').name('▶ Monta gomme nuove');

    // ---- Ambiente e regole ----
    const fe = this.gui.addFolder('Ambiente e simulazione');
    fe.add(sim, 'airTemp', 5, 40, 1).name('Temp. aria (°C)').onChange(cb.onSimChange);
    fe.add(sim, 'trackTemp', 5, 60, 1).name('Temp. asfalto (°C)').onChange(cb.onSimChange);
    fe.add(sim, 'wearMultiplier', 0, 10, 0.5).name('Moltiplicatore usura').onChange(cb.onSimChange);
    fe.add(sim, 'tyreBlankets').name('Termocoperte').onChange(cb.onSimChange);

    // ---- Sospensioni ----
    const s = car.suspension;
    const fs = this.gui.addFolder('Sospensioni');
    fs.add(s, 'springFront', 60000, 300000, 1000).name('Molla ant. (N/m)');
    fs.add(s, 'springRear', 60000, 300000, 1000).name('Molla post. (N/m)');
    fs.add(s, 'arbFront', 0, 250000, 1000).name('Barra antirollio ant.');
    fs.add(s, 'arbRear', 0, 250000, 1000).name('Barra antirollio post.');
    fs.add(s, 'bumpFront', 1000, 15000, 100).name('Ammort. ant. compressione');
    fs.add(s, 'reboundFront', 1000, 15000, 100).name('Ammort. ant. estensione');
    fs.add(s, 'bumpRear', 1000, 15000, 100).name('Ammort. post. compressione');
    fs.add(s, 'reboundRear', 1000, 15000, 100).name('Ammort. post. estensione');
    fs.close();

    // ---- Auto ----
    const fc = this.gui.addFolder('Auto – fisica');
    fc.add(car, 'mass', 900, 2000, 10).name('Massa (kg)');
    fc.add(car, 'fuelKg', 0, 120, 1).name('Carburante (kg)');
    fc.add(car, 'yawInertia', 1000, 4000, 50).name('Inerzia imbardata');
    fc.add(car, 'cgHeight', 0.25, 0.7, 0.01).name('Altezza baricentro (m)');
    fc.add(car, 'steeringRatio', 8, 20, 0.5).name('Rapporto sterzo');
    fc.add(car, 'maxBrakeTorque', 3000, 12000, 100).name('Coppia frenante (Nm)');
    fc.add(car, 'brakeBiasFront', 0.4, 0.75, 0.005).name('Ripartizione freni ant.');
    fc.add(car, 'diffPreload', 0, 400, 5).name('Differenziale: precarico (Nm)');
    fc.add(car, 'diffPowerLock', 0, 1, 0.05).name('Differenziale: bloccaggio trazione');
    fc.add(car, 'diffCoastLock', 0, 1, 0.05).name('Differenziale: bloccaggio rilascio');
    fc.add(car, 'liftArea', 0, 4, 0.05).name('Deportanza Cl·A');
    fc.add(car, 'aeroBalanceFront', 0.3, 0.6, 0.01).name('Bilanc. aero ant.');
    fc.add(car, 'dragArea', 0.3, 1.5, 0.01).name('Resistenza Cd·A');
    fc.close();

    const ft = this.gui.addFolder('Modello gomma (avanzato)');
    ft.add(car.tire, 'mu', 0.8, 2.2, 0.01).name('Aderenza μ');
    ft.add(car.tire, 'loadSensitivity', 0, 0.3, 0.01).name('Sensibilità al carico');
    ft.add(car.tire, 'peakSlipRatio', 0.03, 0.2, 0.005).name('Slip ratio di picco');
    ft.add(car.tire, 'peakSlipAngleDeg', 3, 14, 0.1).name('Deriva di picco (°)');
    ft.add(car.tire, 'slideFactor', 0.5, 1, 0.01).name('Aderenza in scivolata');
    ft.add(car.tire, 'falloff', 0.2, 3, 0.05).name('Caduta oltre il picco');
    ft.add(car.tire, 'optimalPressure', 1.5, 2.5, 0.01).name('Pressione ideale a caldo');
    ft.add(car.tire.thermal, 'slipHeatFraction', 0.05, 1, 0.01).name('Calore da strisciamento');
    ft.add(car.tire.thermal, 'airCoolSpeed', 0, 15, 0.5).name('Raffreddamento aria');
    ft.add(car.tire.thermal, 'wearPerMJ', 0, 0.2, 0.005).name('Usura per MJ');
    ft.close();

    const fw = this.gui.addFolder('Volante / pedali');
    const save = () => input.saveWheelSettings();
    const w = input.wheel;
    fw.add(this.live, 'periferica').name('Rilevato').listen().disable();
    fw.add(this.live, 'assi').name('Assi grezzi').listen().disable();
    fw.add(this.live, 'pulsanti').name('Pulsanti premuti').listen().disable();
    fw.add(w, 'steerAxis', 0, 9, 1).name('Asse sterzo').onChange(save);
    fw.add(w, 'throttleAxis', 0, 9, 1).name('Asse acceleratore').onChange(save);
    fw.add(w, 'brakeAxis', 0, 9, 1).name('Asse freno').onChange(save);
    fw.add(w, 'pedalsInverted').name('Pedali invertiti').onChange(save);
    fw.add(w, 'invertSteer').name('Inverti sterzo').onChange(save);
    fw.add(w, 'hardwareLockDeg', 180, 1080, 10).name('Rotazione volante (°)').onChange(save);
    fw.add(w, 'shiftUpButton', 0, 30, 1).name('Pulsante marcia su').onChange(save);
    fw.add(w, 'shiftDownButton', 0, 30, 1).name('Pulsante marcia giù').onChange(save);
    fw.close();

    const fau = this.gui.addFolder('Audio');
    fau.add(audio, 'volume', 0, 1, 0.01).name('Volume').onChange((v: number) => audio.setVolume(v));
    fau.close();

    this.gui.add({ esporta: () => exportJSON(car) }, 'esporta').name('Esporta auto (JSON)');
  }

  toggle(): void {
    this.gui.show(this.gui._hidden);
  }

  /** Aggiorna le letture live (chiamato a ogni frame). */
  update(): void {
    if (this.gui._hidden) return;
    const i = this.input;
    this.live.periferica = i.gamepadName ? i.gamepadName.slice(0, 40) : 'nessun gamepad';
    this.live.assi = i.rawAxes.map((a, k) => `${k}:${a.toFixed(2)}`).join(' ');
    this.live.pulsanti = i.rawButtons.map((b, k) => (b > 0.5 ? k : -1)).filter((k) => k >= 0).join(', ');
  }
}

function exportJSON(car: CarParams): void {
  const blob = new Blob([JSON.stringify(car, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${car.id}.car.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
