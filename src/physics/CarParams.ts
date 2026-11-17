/**
 * Definizione di un'auto: tutti i numeri che la fisica usa.
 * Le auto vivono come file JSON in /public/cars/*.car.json, così puoi
 * crearne di nuove o modificarle senza toccare il codice.
 *
 * Unità SI: metri, kg, secondi, Newton, Nm. Angoli in GRADI nel JSON
 * (più leggibili), convertiti in radianti nel codice.
 */

export interface TireParams {
  /** Coefficiente di aderenza di picco al carico nominale (gomma slick GT ≈ 1.6). */
  mu: number;
  /** Carico verticale nominale (N) a cui vale `mu`. */
  nominalLoad: number;
  /** Sensibilità al carico: quanto cala μ quando il carico cresce (0 = nessuna). */
  loadSensitivity: number;
  /** Slip ratio longitudinale a cui si ha il picco di forza (es. 0.09 = 9%). */
  peakSlipRatio: number;
  /** Angolo di deriva a cui si ha il picco di forza laterale (gradi). */
  peakSlipAngleDeg: number;
  /** Aderenza residua in pieno scivolamento, come frazione del picco (es. 0.78). */
  slideFactor: number;
  /** Quanto velocemente si cade dal picco alla zona di scivolamento. */
  falloff: number;
  /** Lunghezze di rilassamento (m): ritardo con cui la gomma "costruisce" la forza. */
  relaxLong: number;
  relaxLat: number;
  /** Resistenza al rotolamento (frazione del carico). */
  rollingResistance: number;
}

export interface CarParams {
  id: string;
  name: string;
  /** Percorso del modello GLB (relativo a /public). Se manca o non si carica → segnaposto. */
  model?: string;
  /** Se true e il GLB ha le ruote, passo/carreggiata/raggio vengono letti dal modello. */
  geometryFromModel?: boolean;

  // --- Massa e geometria ---
  mass: number; // kg, con pilota
  yawInertia: number; // kg·m², inerzia attorno all'asse verticale
  cgHeight: number; // m, altezza baricentro
  wheelbase: number; // m, passo
  trackFront: number; // m, carreggiata
  trackRear: number;
  weightFront: number; // frazione del peso sull'anteriore (0..1)
  rollStiffnessFront: number; // frazione della rigidezza a rollio sull'anteriore (0..1)
  /** Costante di tempo (s) con cui il carico si trasferisce: imita la risposta delle sospensioni. */
  loadTransferLag: number;

  // --- Ruote ---
  wheelRadius: number; // m
  wheelInertia: number; // kg·m², ruota + freno
  tire: TireParams;

  // --- Sterzo ---
  steeringLockDeg: number; // rotazione totale volante (es. 540°)
  steeringRatio: number; // gradi volante / gradi ruota

  // --- Motore ---
  idleRpm: number;
  maxRpm: number;
  /** Curva di coppia a pieno gas: [[rpm, Nm], ...] */
  torqueCurve: [number, number][];
  /** Coppia di freno motore a gas chiuso: [[rpm, Nm], ...] (valori positivi) */
  engineBrakeCurve: [number, number][];
  engineInertia: number; // kg·m²

  // --- Trasmissione ---
  gears: number[]; // rapporti marce avanti (1ª, 2ª, ...)
  reverseGear: number; // rapporto retromarcia (positivo)
  finalDrive: number;
  drivetrainEfficiency: number;
  shiftTime: number; // s, tempo di cambiata (gas tagliato)
  /** Differenziale autobloccante semplice: coppia trasferita per rad/s di differenza (Nm·s). */
  diffLockCoeff: number;

  // --- Freni ---
  maxBrakeTorque: number; // Nm totali su tutte e 4 le ruote
  brakeBiasFront: number; // frazione all'anteriore (0..1)

  // --- Aerodinamica ---
  dragArea: number; // Cd·A (m²)
  liftArea: number; // Cl·A (m²), deportanza
  aeroBalanceFront: number; // frazione della deportanza all'anteriore

  // --- Carburante (Fase 7: consumo; ora conta solo il peso) ---
  fuelKg: number;
}

/** Carica un'auto da /public/cars. */
export async function loadCar(url: string): Promise<CarParams> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Impossibile caricare l'auto: ${url}`);
  return (await res.json()) as CarParams;
}
