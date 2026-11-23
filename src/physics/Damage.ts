/**
 * DANNI DELL'AUTO (dagli urti con le altre auto).
 *
 * Ogni parte va da 0 (intatta) a 1 (distrutta):
 *   - ala anteriore: meno carico davanti → sottosterzo, un po' più di resistenza;
 *   - ala posteriore: meno carico dietro → sovrasterzo nelle curve veloci;
 *   - fondo: meno effetto suolo/carico in generale;
 *   - sospensione (con il lato): l'auto tira da quella parte e le gomme di quel lato tengono meno;
 *   - motore: meno potenza; distrutto = ritiro;
 *   - foratura (per ruota): la gomma non tiene quasi più → bisogna rientrare subito.
 *
 * Dove arriva il colpo conta: davanti si rompe l'ala, dietro l'ala posteriore e il fondo, di lato
 * le sospensioni. La forza del colpo è la velocità d'urto (m/s) tra le due auto.
 */

export interface DamageEffects {
  /** moltiplicatori del carico aerodinamico davanti/dietro e della resistenza */
  aeroFront: number;
  aeroRear: number;
  drag: number;
  /** angolo di sterzo in più (rad, + = tira a sinistra) */
  steerPull: number;
  /** moltiplicatore della potenza */
  power: number;
}

export class DamageState {
  frontWing = 0;
  rearWing = 0;
  floor = 0;
  suspension = 0;
  /** lato della sospensione danneggiata: +1 sinistra, −1 destra */
  suspSide = 0;
  engine = 0;
  /** foratura: ant. sx, ant. dx, post. sx, post. dx */
  puncture = [false, false, false, false];

  /** C'è qualcosa di rotto? (per l'HUD) */
  get any(): boolean {
    return this.frontWing > 0.02 || this.rearWing > 0.02 || this.floor > 0.02 || this.suspension > 0.02 || this.engine > 0.02 || this.puncture.some(Boolean);
  }

  /** Danni che costringono al ritiro */
  get fatal(): boolean {
    return this.suspension >= 1 || this.engine >= 1;
  }

  reset(): void {
    this.frontWing = this.rearWing = this.floor = this.suspension = this.engine = 0;
    this.suspSide = 0;
    this.puncture = [false, false, false, false];
  }

  /** Ai box: ala nuova (anteriore) e posteriore sistemata, fondo e sospensioni no */
  repairWings(): void {
    this.frontWing = 0;
    this.rearWing = Math.min(this.rearWing, 0.1);
  }

  effects(): DamageEffects {
    return {
      aeroFront: 1 - 0.45 * this.frontWing - 0.15 * this.floor,
      aeroRear: 1 - 0.4 * this.rearWing - 0.2 * this.floor,
      drag: 1 + 0.06 * (this.frontWing + this.rearWing + this.floor),
      steerPull: 0.03 * this.suspension * this.suspSide,
      power: 1 - 0.3 * this.engine,
    };
  }

  /** Moltiplicatore di aderenza della ruota i (foratura, sospensione di quel lato) */
  wheelGrip(i: number): number {
    let g = this.puncture[i] ? 0.35 : 1;
    const side = i % 2 === 0 ? 1 : -1; // 0, 2 = lato sinistro
    if (this.suspension > 0 && side === this.suspSide) g *= 1 - 0.15 * this.suspension;
    return g;
  }

  /**
   * Un colpo nel punto (long, lat) dell'auto (m, dal baricentro: + avanti, + sinistra).
   * @param speed velocità d'urto (m/s)
   * @returns le parti che si sono rotte (per i messaggi), vuoto se niente di serio
   */
  hit(long: number, lat: number, halfLength: number, halfWidth: number, speed: number, rnd = Math.random): string[] {
    const sev = Math.min(1.6, Math.max(0, (speed - 5) / 20));
    if (sev <= 0) return [];
    const before = { fw: this.frontWing, rw: this.rearWing, fl: this.floor, su: this.suspension, en: this.engine, pu: this.puncture.filter(Boolean).length };
    const side = lat >= 0 ? 1 : -1;
    const add = (v: number, d: number) => Math.min(1, v + d);
    const puncture = (front: boolean) => {
      const i = (front ? 0 : 2) + (side > 0 ? 0 : 1);
      this.puncture[i] = true;
    };
    if (long > halfLength * 0.45) {
      // davanti: l'ala anteriore è la prima a rompersi
      this.frontWing = add(this.frontWing, sev * 1.1);
      if (Math.abs(lat) > halfWidth * 0.5 && sev > 0.25) this.setSusp(sev * 0.5, side);
      if (sev > 0.35 && rnd() < 0.35) puncture(true);
    } else if (long < -halfLength * 0.45) {
      // dietro: ala posteriore e fondo; le gomme posteriori si tagliano facilmente
      this.rearWing = add(this.rearWing, sev * 0.7);
      this.floor = add(this.floor, sev * 0.2);
      if (sev > 0.3 && rnd() < 0.45) puncture(false);
    } else {
      // di lato: sospensioni e fondo
      this.setSusp(sev * 0.6, side);
      this.floor = add(this.floor, sev * 0.25);
      if (sev > 0.35 && rnd() < 0.4) puncture(rnd() < 0.5);
    }
    if (sev > 0.9) this.engine = add(this.engine, (sev - 0.9) * 1.5);
    const out: string[] = [];
    if (this.frontWing - before.fw > 0.08) out.push('ala anteriore');
    if (this.rearWing - before.rw > 0.08) out.push('ala posteriore');
    if (this.floor - before.fl > 0.1) out.push('fondo');
    if (this.suspension - before.su > 0.08) out.push(`sospensione ${this.suspSide > 0 ? 'sinistra' : 'destra'}`);
    if (this.engine - before.en > 0.05) out.push('motore');
    if (this.puncture.filter(Boolean).length > before.pu) out.push('foratura');
    return out;
  }

  private setSusp(d: number, side: number): void {
    if (this.suspension < 0.05) this.suspSide = side;
    this.suspension = Math.min(1, this.suspension + d);
  }

  /** Descrizione per la radio */
  describe(): string {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const parts: string[] = [];
    if (this.frontWing > 0.02) parts.push(`ala anteriore ${pct(this.frontWing)}`);
    if (this.rearWing > 0.02) parts.push(`ala posteriore ${pct(this.rearWing)}`);
    if (this.floor > 0.02) parts.push(`fondo ${pct(this.floor)}`);
    if (this.suspension > 0.02) parts.push(`sospensione ${this.suspSide > 0 ? 'sinistra' : 'destra'} ${pct(this.suspension)} (tira da quel lato)`);
    if (this.engine > 0.02) parts.push(`motore ${pct(this.engine)}`);
    const names = ['anteriore sinistra', 'anteriore destra', 'posteriore sinistra', 'posteriore destra'];
    this.puncture.forEach((p, i) => p && parts.push(`<b>foratura ${names[i]}</b>`));
    return parts.join(', ');
  }

  /** Quanto più piano deve andare un bot con questi danni (moltiplicatore della velocità) */
  paceFactor(): number {
    return Math.max(0.55, 1 - 0.06 * this.frontWing - 0.05 * this.rearWing - 0.04 * this.floor - 0.05 * this.suspension - 0.05 * this.engine
      - (this.puncture.some(Boolean) ? 0.3 : 0));
  }
}
