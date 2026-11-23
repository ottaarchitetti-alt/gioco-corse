/**
 * DIREZIONE GARA: neutralizzazioni (solo in gara).
 *
 *   VSC (virtual safety car): un'auto ferma vicino al bordo. Tutti rallentano (velocità massima
 *        ~60% del normale, indicata nell'HUD), niente sorpassi. Chi va troppo forte: +5 s.
 *   SAFETY CAR: un'auto ferma IN PISTA. La safety car (un'auto vera) entra davanti al leader e
 *        guida il gruppo: niente sorpassi, il gruppo si ricompatta. Dopo almeno 2 giri, con la
 *        pista libera, "rientra alla fine di questo giro": si spegne, entra ai box, e si torna a
 *        correre dal traguardo (verde). Sorpasso sotto safety car (o della safety car): +5 s.
 *        È il momento buono per fermarsi ai box (i bot lo sanno).
 *   BANDIERA ROSSA: tre o più auto ferme insieme, oppure pioggia troppo forte. Gara sospesa:
 *        cambio gomme e riparazioni gratis, poi partenza da fermo in griglia nell'ordine della
 *        classifica (i giri fatti restano).
 *
 * Qui c'è solo lo STATO (semplice, così il flashback lo può fotografare); le regole le applica
 * Game, che conosce le auto.
 */

export type RcState = 'verde' | 'vsc' | 'sc' | 'rossa';

export class RaceControl {
  state: RcState = 'verde';
  /** secondi nello stato attuale */
  t = 0;
  reason = '';
  /** auto ferme da quanto (s), per id */
  stoppedT: Record<string, number> = {};
  /** auto già "valutate" (un incidente = una decisione) */
  handled: Record<string, boolean> = {};
  /** safety car: giri completati dal leader da quando è entrata, rientro annunciato, uscita fatta */
  scLaps = 0;
  ending = false;
  scOut = false;
  /** safety car rientrata: niente sorpassi fino al traguardo */
  noPassUntilLine = false;
  /** pista libera da quanto (s) */
  clearT = 0;
  /** pioggia oltre il limite da quanto (s) */
  rainT = 0;
  /** pilota: posizione di riferimento sotto neutralizzazione, tempo "guadagnato", tempo oltre il limite VSC */
  refPos = 0;
  gainT = 0;
  overT = 0;
  passedSc = false;

  reset(): void {
    Object.assign(this, new RaceControl());
  }

  get neutralized(): boolean {
    return this.state === 'vsc' || this.state === 'sc';
  }

  /** Testo del banner dell'HUD */
  banner(vscLimitKmh: number | null): { cls: string; html: string } | null {
    switch (this.state) {
      case 'vsc':
        return { cls: 'vsc', html: `<b>VSC</b> · virtual safety car · niente sorpassi${vscLimitKmh ? ` · max <b>${Math.round(vscLimitKmh)} km/h</b>` : ''}` };
      case 'sc':
        return { cls: 'sc', html: this.ending ? '<b>SAFETY CAR</b> · rientra alla fine di questo giro' : this.scOut ? '<b>SAFETY CAR</b> in pista · niente sorpassi' : '<b>SAFETY CAR</b> in arrivo · rallenta' };
      case 'rossa':
        return { cls: 'rossa', html: '<b>BANDIERA ROSSA</b> · gara sospesa' };
      default:
        return this.noPassUntilLine ? { cls: 'sc', html: 'Safety car ai box · <b>niente sorpassi fino al traguardo</b>' } : null;
    }
  }
}
