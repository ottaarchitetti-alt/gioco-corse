/**
 * Definizione di un'auto: tutti i numeri che la fisica usa.
 * Le auto vivono come file JSON in /public/cars/*.car.json, così puoi
 * crearne di nuove o modificarle senza toccare il codice.
 *
 * Unità SI: metri, kg, secondi, Newton, Nm, Watt, °C, bar.
 * Angoli in GRADI nel JSON (più leggibili), convertiti in radianti nel codice.
 *
 * I campi del gruppo "setup" sono quelli che dalla Fase 7 si regoleranno
 * dal menu assetto (pressioni, mescola, molle, barre, freni, differenziale...).
 */

/** Modello termico della gomma: due "strati", superficie (battistrada) e carcassa. */
export interface TireThermal {
  /** Capacità termica dello strato superficiale (J/K): bassa = si scalda/raffredda in fretta. */
  surfaceCapacity: number;
  /** Capacità termica della carcassa (J/K): alta = cambia temperatura lentamente. */
  coreCapacity: number;
  /** Raffreddamento della superficie verso l'aria: base + per ogni m/s di velocità (W/K). */
  airCoolBase: number;
  airCoolSpeed: number;
  /** Scambio di calore superficie ↔ carcassa (W/K). */
  surfaceToCore: number;
  /** Raffreddamento della carcassa verso aria/cerchio (W/K). */
  coreToAir: number;
  /** Scambio con l'asfalto a carico nominale (W/K). */
  trackConduct: number;
  /** Frazione della potenza di strisciamento che diventa calore nella gomma. */
  slipHeatFraction: number;
  /** Usura: frazione di battistrada consumata per MJ di energia di strisciamento (a moltiplicatore 1). */
  wearPerMJ: number;
}

/** Mescola: modifica aderenza, temperatura ideale, usura, velocità di riscaldamento. */
export interface Compound {
  name: string;
  muMul: number;
  /** Temperatura ideale (°C, media superficie/carcassa). */
  optimalTemp: number;
  wearMul: number;
  heatMul: number;
  /** Colore della fascia sul fianco della gomma (monoposto) */
  color?: string;
}

/**
 * AERODINAMICA ATTIVA (regolamento 2026): sui rettilinei le ali si "aprono"
 * (modalità rettilineo: meno resistenza e meno deportanza), in frenata e in
 * curva si richiudono (modalità curva: valori normali dragArea/liftArea).
 */
export interface ActiveAeroParams {
  straightDragArea: number;
  straightLiftArea: number;
  /** Lunghezza minima (m) di un tratto quasi dritto per diventare zona di aerodinamica attiva */
  minZoneLength: number;
  /** Curvatura massima (1/m) considerata "rettilineo" */
  maxCurvature: number;
}

/**
 * EFFETTO SUOLO semplificato: il fondo genera più carico quanto più è vicino
 * all'asfalto. Se tocca terra (talloneggia) perde una parte del carico.
 */
export interface GroundEffectParams {
  /** Altezza da terra di riferimento del fondo (m), a cui vale liftArea */
  refRideHeight: number;
  /** Aumento relativo di carico per ogni "altezza di riferimento" in meno (es. 0.35) */
  gain: number;
  /** Frazione di carico persa quando il fondo tocca terra */
  bottomingLoss: number;
}

/** SISTEMA IBRIDO (ERS): batteria, MGU-K che spinge e recupera in frenata. */
export interface ErsParams {
  /** Energia utilizzabile della batteria (MJ) */
  batteryMJ: number;
  /** Potenza massima erogata dal motore elettrico (kW) */
  deployKW: number;
  /** Potenza massima recuperata in frenata (kW) */
  harvestKW: number;
  /** Energia massima recuperabile per giro (MJ) */
  harvestPerLapMJ: number;
  /** Recupero in rilascio senza freno (kW) */
  coastHarvestKW: number;
  /** Sopra questa velocità la spinta elettrica cala fino a zero a taperEndKmh */
  taperStartKmh: number;
  taperEndKmh: number;
  /** Con l'Overtake mode la spinta piena dura fino a questa velocità (poi cala come sopra) */
  overtakeTaperStartKmh: number;
  /** Energia extra concessa nel giro con l'Overtake mode (MJ) */
  overtakeExtraMJ: number;
}

export interface PitParams {
  /** Tempo fisso di una sosta (s): fermata, cric, ripartenza */
  fixedTime: number;
  /** Tempo per cambiare le 4 gomme (s) */
  tyreChangeTime: number;
  /** Rifornimento ammesso */
  refuel: boolean;
}

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
  /** Pressione a caldo ideale (bar). */
  optimalPressure: number;
  thermal: TireThermal;
  compounds: Record<string, Compound>;
}

export interface SuspensionParams {
  /** Massa non sospesa per ruota (ruota, freno, portamozzo) in kg. */
  unsprungMass: number;
  /** Rigidezza molle riportata alla ruota (N/m). */
  springFront: number;
  springRear: number;
  /** Ammortizzatori (N·s/m): compressione (bump) ed estensione (rebound). */
  bumpFront: number;
  reboundFront: number;
  bumpRear: number;
  reboundRear: number;
  /** Barre antirollio riportate alla ruota (N/m). */
  arbFront: number;
  arbRear: number;
  /** Inerzie della massa sospesa (kg·m²). */
  pitchInertia: number;
  rollInertia: number;
}

/** Valori regolabili dal pilota (Fase 7: menu assetto). */
export interface CarSetup {
  compound: string;
  /** Pressione a freddo (bar, relativa) */
  pressureFront: number;
  pressureRear: number;
  /** Altezza da terra statica del fondo (m), solo auto a effetto suolo */
  rideHeight?: number;
}

export interface CarParams {
  id: string;
  name: string;
  /** Percorso del modello GLB (relativo a /public). Se manca o non si carica → segnaposto. */
  model?: string;
  /** Se true e il GLB ha le ruote, passo/carreggiata/raggio vengono letti dal modello. */
  geometryFromModel?: boolean;
  /** Forma del modello segnaposto: 'gt' (predefinito) o 'monoposto' */
  body?: 'gt' | 'monoposto';
  /** Ingombro per le collisioni (m): metà lunghezza e metà larghezza */
  collision?: { halfLength: number; halfWidth: number };

  // --- Massa e geometria ---
  mass: number; // kg, con pilota, senza carburante
  yawInertia: number; // kg·m², inerzia attorno all'asse verticale
  cgHeight: number; // m, altezza baricentro
  wheelbase: number; // m, passo
  trackFront: number; // m, carreggiata
  trackRear: number;
  weightFront: number; // frazione del peso sull'anteriore (0..1)
  suspension: SuspensionParams;

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
  /** Differenziale autobloccante a rampe (a frizioni). */
  diffPreload: number; // Nm di bloccaggio sempre presente
  diffPowerLock: number; // frazione della coppia in trazione usata per bloccare (0..1)
  diffCoastLock: number; // frazione della coppia in rilascio/freno motore (0..1)

  // --- Freni ---
  maxBrakeTorque: number; // Nm totali su tutte e 4 le ruote
  brakeBiasFront: number; // frazione all'anteriore (0..1)

  // --- Aerodinamica ---
  dragArea: number; // Cd·A (m²)
  liftArea: number; // Cl·A (m²), deportanza
  aeroBalanceFront: number; // frazione della deportanza all'anteriore
  activeAero?: ActiveAeroParams;
  groundEffect?: GroundEffectParams;
  ers?: ErsParams;

  // --- Box e regole ---
  /** Tempi del pit stop; se assente valori GT (gomme 13 s, rifornimento sì) */
  pit?: PitParams;
  /** Regole di gara della categoria */
  rules?: { twoCompounds?: boolean };

  // --- Carburante ---
  /** Carburante di partenza predefinito (kg) */
  fuelKg: number;
  /** Capacità del serbatoio (kg) */
  fuelCapacity: number;
  /** Rendimento termico del motore (frazione dell'energia del carburante che diventa lavoro) */
  engineEfficiency: number;
  /** Taratura dei bot: frazione dell'aderenza nominale sfruttabile in curva (GT 0,85) */
  botGripFactor?: number;
  /** Stima iniziale del consumo (kg/km) prima di averlo misurato in pista */
  fuelPerKmEst?: number;

  /** Assetto di partenza */
  setup: CarSetup;
}

/** Carica un'auto da /public/cars. */
export async function loadCar(url: string): Promise<CarParams> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Impossibile caricare l'auto: ${url}`);
  return (await res.json()) as CarParams;
}

/** Una voce dell'elenco auto (public/cars/index.json). */
export interface CarEntry {
  id: string;
  name: string;
  file: string;
  description?: string;
}

/** Elenco delle auto disponibili. */
export async function listCars(): Promise<CarEntry[]> {
  const res = await fetch('cars/index.json', { cache: 'no-cache' });
  return res.ok ? ((await res.json()) as CarEntry[]) : [{ id: 'gt_segnaposto', name: 'GT', file: 'gt_segnaposto.car.json' }];
}
