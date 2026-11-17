/**
 * Menu ASSETTO (dalla scelta della sessione o dal menu di pausa).
 * Le regolazioni meccaniche valgono subito; mescola, pressioni e carburante
 * valgono alla prossima partenza o al prossimo pit stop (gomme e benzina
 * non si cambiano "al volo").
 */
import type { CarParams } from '../physics/CarParams';
import { defaultSetup, type SetupValues } from './Setup';

interface Row {
  key: keyof SetupValues;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  help: string;
}

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: 'Aerodinamica',
    rows: [
      { key: 'frontWing', label: 'Ala anteriore', min: 1, max: 10, step: 1, unit: '', help: 'Più ala = più aderenza davanti in curva veloce (meno sottosterzo), un po\' più di resistenza.' },
      { key: 'rearWing', label: 'Ala posteriore', min: 1, max: 10, step: 1, unit: '', help: 'Più ala = posteriore più stabile in curva veloce, ma meno velocità di punta.' },
    ],
  },
  {
    title: 'Trasmissione',
    rows: [
      { key: 'finalDrive', label: 'Rapporto finale', min: 3.0, max: 4.4, step: 0.05, unit: '', help: 'Più alto = più accelerazione, meno velocità massima. Regolalo per arrivare al limitatore a fine rettilineo.' },
      { key: 'diffPreload', label: 'Differenziale: precarico', min: 0, max: 300, step: 10, unit: 'Nm', help: 'Bloccaggio sempre presente: stabilità, ma l\'auto gira meno volentieri a centro curva.' },
      { key: 'diffPower', label: 'Differenziale: in trazione', min: 0, max: 100, step: 5, unit: '%', help: 'Più alto = più motricità in uscita, ma più sottosterzo col gas.' },
      { key: 'diffCoast', label: 'Differenziale: in rilascio', min: 0, max: 100, step: 5, unit: '%', help: 'Più alto = più stabile in frenata/inserimento, ma meno rotazione.' },
    ],
  },
  {
    title: 'Sospensioni',
    rows: [
      { key: 'springFront', label: 'Molle anteriori', min: 80, max: 250, step: 5, unit: 'N/mm', help: 'Più rigide = risposta più pronta, ma meno aderenza sui cordoli e sulle sconnessioni.' },
      { key: 'springRear', label: 'Molle posteriori', min: 80, max: 250, step: 5, unit: 'N/mm', help: 'Come sopra, per il posteriore.' },
      { key: 'arbFront', label: 'Barra antirollio ant.', min: 1, max: 10, step: 1, unit: '', help: 'Più rigida = più sottosterzo (meno rollio davanti).' },
      { key: 'arbRear', label: 'Barra antirollio post.', min: 1, max: 10, step: 1, unit: '', help: 'Più rigida = più sovrasterzo (meno rollio dietro).' },
      { key: 'damperFront', label: 'Ammortizzatori ant.', min: 1, max: 10, step: 1, unit: '', help: 'Più duri = il carico si sposta più in fretta (auto più nervosa nei transitori).' },
      { key: 'damperRear', label: 'Ammortizzatori post.', min: 1, max: 10, step: 1, unit: '', help: 'Come sopra, per il posteriore.' },
    ],
  },
  {
    title: 'Freni',
    rows: [
      { key: 'brakeBias', label: 'Ripartizione anteriore', min: 50, max: 70, step: 0.5, unit: '%', help: 'Più avanti = stabile in frenata ma rischio di bloccare le anteriori; più indietro = più rotazione ma meno stabilità.' },
    ],
  },
  {
    title: 'Gomme e carburante (dalla prossima partenza o sosta)',
    rows: [
      { key: 'pressureFront', label: 'Pressione ant. a freddo', min: 1.0, max: 2.2, step: 0.05, unit: 'bar', help: 'Si alza scaldandosi: cerca circa 2,0 bar a caldo (guarda l\'HUD gomme).' },
      { key: 'pressureRear', label: 'Pressione post. a freddo', min: 1.0, max: 2.2, step: 0.05, unit: 'bar', help: 'Come sopra.' },
      { key: 'fuel', label: 'Carburante alla partenza', min: 5, max: 110, step: 1, unit: 'kg', help: 'Più benzina = più giri senza fermarsi, ma auto più pesante (più lenta e usura gomme maggiore).' },
    ],
  },
];

export class SetupMenu {
  private el: HTMLDivElement;
  private draft: SetupValues;

  constructor(
    private car: CarParams,
    private base: CarParams,
    current: SetupValues,
    private fuelPerLap: number | null,
    private onSave: (s: SetupValues) => void,
    private onClose: () => void = () => {},
  ) {
    this.draft = { ...current };
    this.el = document.createElement('div');
    this.el.className = 'overlay setup-menu';
    document.body.appendChild(this.el);
  }

  open(): void {
    this.render();
  }

  private close(): void {
    this.el.remove();
    this.onClose();
  }

  private fmt(r: Row, v: number): string {
    const dec = r.step < 0.1 ? 2 : r.step < 1 ? 1 : 0;
    return `${v.toFixed(dec)}${r.unit ? ' ' + r.unit : ''}`;
  }

  private render(): void {
    const d = this.draft;
    const compounds = Object.entries(this.car.tire.compounds);
    const groups = GROUPS.map((g) => `
      <h2>${g.title}</h2>
      ${g.rows.map((r) => `
        <div class="srow">
          <label>${r.label} <b data-v="${r.key}">${this.fmt(r, d[r.key] as number)}</b></label>
          <input type="range" min="${r.min}" max="${r.key === 'fuel' ? this.base.fuelCapacity : r.max}" step="${r.step}" value="${d[r.key]}" data-k="${r.key}">
          <small>${r.help}</small>
        </div>`).join('')}`).join('');
    const fuelInfo = this.fuelPerLap ? `<p class="small">Consumo stimato: <b>${this.fuelPerLap.toFixed(2)} kg/giro</b> → con ${d.fuel} kg circa <b>${Math.floor(d.fuel / this.fuelPerLap)} giri</b>.</p>` : '';
    this.el.innerHTML = `
      <div class="card wide">
        <h1>🔧 Assetto</h1>
        <p class="small">${this.car.name} · le regolazioni sono salvate per questa pista.</p>
        <h2>Mescola</h2>
        <div class="segs">${compounds.map(([id, c]) => `<button class="seg ${d.compound === id ? 'on' : ''}" data-c="${id}">${c.name}</button>`).join('')}</div>
        <p class="small">Morbida: più aderenza, si scalda prima, si consuma in fretta. Dura: dura di più, serve più temperatura.</p>
        ${groups}
        ${fuelInfo}
        <div class="actions">
          <button data-a="save">💾 Applica e salva</button>
          <button class="secondary" data-a="reset">Ripristina di fabbrica</button>
          <button class="secondary" data-a="close">Annulla</button>
        </div>
      </div>`;
    this.el.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((el) =>
      el.addEventListener('input', () => {
        const k = el.dataset.k as keyof SetupValues;
        (d as unknown as Record<string, number>)[k] = parseFloat(el.value);
        const row = GROUPS.flatMap((g) => g.rows).find((r) => r.key === k)!;
        (this.el.querySelector(`[data-v="${k}"]`) as HTMLElement).textContent = this.fmt(row, d[k] as number);
      }),
    );
    this.el.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((b) =>
      b.addEventListener('click', () => { d.compound = b.dataset.c!; this.render(); }),
    );
    const act: Record<string, () => void> = {
      save: () => { this.onSave({ ...this.draft }); this.close(); },
      reset: () => { this.draft = defaultSetup(this.base); this.render(); },
      close: () => this.close(),
    };
    this.el.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) => b.addEventListener('click', act[b.dataset.a!]));
  }
}
