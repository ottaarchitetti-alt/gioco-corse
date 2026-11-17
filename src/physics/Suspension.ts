/**
 * Sospensioni e massa sospesa.
 *
 * La carrozzeria (massa sospesa) ha 3 gradi di libertà: SCUOTIMENTO (su/giù),
 * BECCHEGGIO (muso giù/su) e ROLLIO (inclinazione laterale). È appoggiata
 * sulle 4 ruote tramite molle, ammortizzatori e barre antirollio.
 *
 * Il trasferimento di carico NON è più una formula istantanea: quando freni
 * la carrozzeria si inclina in avanti, le molle anteriori si comprimono e
 * SOLO ALLORA il carico arriva alle gomme anteriori. La velocità con cui
 * succede dipende da molle e ammortizzatori → l'assetto cambia la guida.
 *
 *   - molle più rigide  → l'auto risponde prima, ma "copia" di più cordoli e sconnessioni
 *   - barra ant. più rigida → più carico trasferito sull'anteriore in curva → più sottosterzo
 *   - ammortizzatori → quanto velocemente il carico si sposta (transitori)
 *
 * Convenzioni: compressione > 0 = molla più schiacciata;
 * beccheggio > 0 = muso giù; rollio > 0 = lato DESTRO giù.
 */
import { GRAVITY } from './constants';
import type { CarParams } from './CarParams';

export class Suspension {
  heave = 0; // m, + = carrozzeria più alta
  heaveV = 0;
  pitch = 0; // rad
  pitchV = 0;
  roll = 0; // rad
  rollV = 0;
  /** Compressione dinamica di ogni sospensione rispetto alla posizione statica (m). */
  readonly compression = [0, 0, 0, 0];
  /** Forza di ogni sospensione sulla carrozzeria (N). */
  readonly forces = [0, 0, 0, 0];
  private prevCompression = [0, 0, 0, 0];

  constructor(
    private car: CarParams,
    /** [laterale(+sx), longitudinale(+avanti)] di ogni ruota rispetto al baricentro */
    private wheelPos: [number, number][],
    private cgToFront: number,
    private cgToRear: number,
  ) {}

  reset(): void {
    this.heave = this.heaveV = this.pitch = this.pitchV = this.roll = this.rollV = 0;
    this.compression.fill(0);
    this.prevCompression.fill(0);
  }

  /**
   * Calcola le forze delle sospensioni e restituisce il CARICO su ogni gomma (N).
   * @param totalMass massa totale dell'auto (con carburante)
   * @param roadHeight altezza dell'asfalto sotto ogni ruota (cordoli, sconnessioni)
   */
  wheelLoads(totalMass: number, roadHeight: number[], dt: number, out: number[]): void {
    const s = this.car.suspension;
    const L = this.car.wheelbase;
    const sprung = totalMass - 4 * s.unsprungMass;

    for (let i = 0; i < 4; i++) {
      const [pLat, pLong] = this.wheelPos[i];
      // geometria: come la carrozzeria (e la strada) comprimono questa sospensione
      this.compression[i] = -this.heave + this.pitch * pLong - this.roll * pLat + roadHeight[i];
    }

    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const k = front ? s.springFront : s.springRear;
      // Carico statico di questa ruota (la molla è precaricata per sostenerlo)
      const staticLoad = (sprung * GRAVITY * (front ? this.cgToRear : this.cgToFront)) / L / 2;
      const rate = (this.compression[i] - this.prevCompression[i]) / dt;
      const damper = rate > 0 ? (front ? s.bumpFront : s.bumpRear) : front ? s.reboundFront : s.reboundRear;
      // barra antirollio: si oppone alla differenza di compressione tra sinistra e destra
      const other = i % 2 === 0 ? i + 1 : i - 1;
      const arb = (front ? s.arbFront : s.arbRear) * (this.compression[i] - this.compression[other]);
      // una sospensione può solo spingere: se si estende troppo la ruota si stacca (forza 0)
      this.forces[i] = Math.max(0, staticLoad + k * this.compression[i] + damper * rate + arb);
      out[i] = this.forces[i] + s.unsprungMass * GRAVITY;
    }
    for (let i = 0; i < 4; i++) this.prevCompression[i] = this.compression[i];
  }

  /**
   * Muove la carrozzeria sotto l'effetto di sospensioni, inerzia e deportanza.
   * @param aLong, aLat accelerazioni dell'auto (m/s²) nel suo riferimento
   */
  integrate(totalMass: number, aLong: number, aLat: number, downFront: number, downRear: number, dt: number): void {
    const s = this.car.suspension;
    const sprung = totalMass - 4 * s.unsprungMass;
    const h = this.car.cgHeight;

    let fz = 0, mPitch = 0, mRoll = 0;
    for (let i = 0; i < 4; i++) {
      const [pLat, pLong] = this.wheelPos[i];
      const staticLoad = (sprung * GRAVITY * (i < 2 ? this.cgToRear : this.cgToFront)) / this.car.wheelbase / 2;
      const dyn = this.forces[i] - staticLoad; // parte dinamica (il peso statico è già bilanciato)
      fz += dyn;
      mPitch -= this.forces[i] * pLong; // spinta in alto davanti → muso su
      mRoll += this.forces[i] * pLat; // spinta in alto a sinistra → destra giù
    }
    // Inerzia: frenando (aLong < 0) il muso scende; curvando a sinistra (aLat > 0) la destra scende
    mPitch += -sprung * aLong * h + downFront * this.cgToFront - downRear * this.cgToRear;
    mRoll += sprung * aLat * h;
    fz -= downFront + downRear;

    // Eulero semi-implicito (stabile per queste frequenze, ~3 Hz, a 240 Hz)
    this.heaveV += (fz / sprung) * dt;
    this.pitchV += (mPitch / s.pitchInertia) * dt;
    this.rollV += (mRoll / s.rollInertia) * dt;
    this.heave += this.heaveV * dt;
    this.pitch += this.pitchV * dt;
    this.roll += this.rollV * dt;
  }
}
