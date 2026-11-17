/**
 * ASSETTO: i valori che il pilota regola dal menu, in unità "da box"
 * (scale 1–10, N/mm, bar, %) e la loro traduzione nei parametri fisici.
 *
 * Effetti principali (la fisica fa il resto, nulla è "programmato"):
 *  - Ali: più ala = più deportanza (aderenza in curva veloce) ma più resistenza
 *    (velocità di punta). Più ala posteriore = più stabile (meno sovrasterzo).
 *  - Rapporto finale: corto = più accelerazione, lungo = più velocità di punta.
 *  - Molle / barre / ammortizzatori: rigidità e reattività; barra anteriore più
 *    rigida = più sottosterzo, posteriore più rigida = più sovrasterzo.
 *  - Pressioni: vedi gomma (ideale ~2,0 bar a caldo).
 *  - Ripartizione freni: più avanti = stabile ma rischio bloccaggio anteriore.
 *  - Differenziale: più bloccaggio in trazione = motricità ma sottosterzo in uscita.
 *
 * Salvato per pista + auto nel browser.
 */
import { loadJSON, saveJSON } from '../core/storage';
import type { CarParams } from '../physics/CarParams';

export interface SetupValues {
  frontWing: number; // 1–10
  rearWing: number; // 1–10
  finalDrive: number;
  springFront: number; // N/mm alla ruota
  springRear: number;
  arbFront: number; // 1–10
  arbRear: number;
  damperFront: number; // 1–10
  damperRear: number;
  pressureFront: number; // bar a freddo
  pressureRear: number;
  brakeBias: number; // % all'anteriore
  diffPreload: number; // Nm
  diffPower: number; // %
  diffCoast: number; // %
  compound: string;
  fuel: number; // kg alla partenza
}

/** Assetto di fabbrica, ricavato dal file dell'auto. */
export function defaultSetup(base: CarParams): SetupValues {
  return {
    frontWing: 5,
    rearWing: 5,
    finalDrive: base.finalDrive,
    springFront: Math.round(base.suspension.springFront / 1000),
    springRear: Math.round(base.suspension.springRear / 1000),
    arbFront: 5,
    arbRear: 5,
    damperFront: 5,
    damperRear: 5,
    pressureFront: base.setup.pressureFront,
    pressureRear: base.setup.pressureRear,
    brakeBias: Math.round(base.brakeBiasFront * 1000) / 10,
    diffPreload: base.diffPreload,
    diffPower: Math.round(base.diffPowerLock * 100),
    diffCoast: Math.round(base.diffCoastLock * 100),
    compound: base.setup.compound,
    fuel: base.fuelKg,
  };
}

/** Scala 1–10 → moltiplicatore (5 = valore di fabbrica). */
const scale = (v: number, span: number) => 1 + (v - 5) * span;

/**
 * Applica l'assetto all'auto.
 * @param car auto da modificare
 * @param base auto di fabbrica (dal file JSON, non modificata)
 */
export function applySetup(car: CarParams, base: CarParams, s: SetupValues): void {
  // Aerodinamica: con ali a 5/5 si ottengono esattamente i valori del file
  const f = s.frontWing, r = s.rearWing;
  car.liftArea = base.liftArea * (0.48 + 0.052 * (f + r));
  car.dragArea = base.dragArea * (0.74 + 0.026 * (0.6 * f + 1.4 * r));
  car.aeroBalanceFront = base.aeroBalanceFront + 0.02 * (f - r);

  car.finalDrive = s.finalDrive;
  const sus = car.suspension, bs = base.suspension;
  sus.springFront = s.springFront * 1000;
  sus.springRear = s.springRear * 1000;
  sus.arbFront = bs.arbFront * scale(s.arbFront, 0.15);
  sus.arbRear = bs.arbRear * scale(s.arbRear, 0.15);
  sus.bumpFront = bs.bumpFront * scale(s.damperFront, 0.1);
  sus.reboundFront = bs.reboundFront * scale(s.damperFront, 0.1);
  sus.bumpRear = bs.bumpRear * scale(s.damperRear, 0.1);
  sus.reboundRear = bs.reboundRear * scale(s.damperRear, 0.1);

  car.brakeBiasFront = s.brakeBias / 100;
  car.diffPreload = s.diffPreload;
  car.diffPowerLock = s.diffPower / 100;
  car.diffCoastLock = s.diffCoast / 100;

  car.setup.compound = s.compound;
  car.setup.pressureFront = s.pressureFront;
  car.setup.pressureRear = s.pressureRear;
  car.fuelKg = Math.min(s.fuel, base.fuelCapacity);
}

const key = (trackId: string, carId: string) => `setup.${trackId}.${carId}`;

export function loadSetup(trackId: string, base: CarParams): SetupValues {
  return loadJSON(key(trackId, base.id), defaultSetup(base));
}

export function saveSetup(trackId: string, carId: string, s: SetupValues): void {
  saveJSON(key(trackId, carId), s);
}
