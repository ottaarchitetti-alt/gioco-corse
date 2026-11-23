/**
 * RADIO DEL BOX
 *
 *  - Messaggi ben visibili in alto al centro: chi parla (box, tu, direzione gara), colore per
 *    importanza, gli ultimi due restano a schermo qualche secondo.
 *  - VOCE: il box parla con la voce sintetica italiana del browser (speechSynthesis), preceduta
 *    dal "bip" della radio. Si attiva/disattiva nelle Impostazioni.
 *  - MENU RADIO (tasto B, volante R2, gamepad croce sinistra): domande e ordini al box con i
 *    numeri 1–9 (volante: batteria su/giù per scegliere, R2 per confermare, quadrato per chiudere).
 *  - COMANDI VOCALI (tasto V, volante L2, gamepad croce destra): parli al microfono, il browser
 *    trascrive (Chrome/Edge: il riconoscimento passa dai server del browser, serve internet) e
 *    la frase viene capita cercando parole chiave ("box questo giro", "quanta benzina",
 *    "metti le intermedie", "come sono le gomme"...).
 *
 * Le risposte le prepara Game (conosce gomme, benzina, distacchi, meteo, danni): qui c'è solo
 * il "telefono".
 */

export type RadioIntent =
  | { type: 'gomme' }
  | { type: 'benzina' }
  | { type: 'distacchi' }
  | { type: 'meteo' }
  | { type: 'danni' }
  | { type: 'strategia' }
  | { type: 'batteria' }
  | { type: 'boxOra' }
  | { type: 'annullaBox' }
  | { type: 'mescola'; compound?: string }
  | { type: 'riparaAla' };

export type RadioFrom = 'box' | 'tu' | 'direzione';
/** info = solo a schermo; importante/risposta = anche a voce; urgente = interrompe la voce */
export type RadioPrio = 'info' | 'importante' | 'risposta' | 'urgente';

interface MenuItem {
  label: () => string;
  intent: () => RadioIntent;
  /** resta aperto dopo la scelta (es. cambio mescola a giro) */
  keepOpen?: boolean;
}

interface Shown {
  el: HTMLDivElement;
  ttl: number;
}

/** Testo leggibile ad alta voce: niente HTML, numeri all'italiana, unità per esteso */
export function speakable(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '. ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .replace(/·/g, ',')
    .replace(/\bP(\d+)\b/g, 'posizione $1')
    .replace(/(\d)\.(\d)/g, '$1 virgola $2')
    .replace(/\+(\d)/g, 'più $1')
    .replace(/(\d)\s?s\b/g, '$1 secondi')
    .replace(/(\d)\s?kg\b/g, '$1 chili')
    .replace(/(\d)\s?%/g, '$1 per cento')
    .replace(/km\/h/g, 'chilometri orari')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Toglie accenti e maiuscole per cercare le parole chiave */
const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Capisce una frase detta al box. Restituisce null se non trova niente di noto.
 * @param compounds mescole dell'auto: id → nome (per "metti le dure", "intermedie"...)
 */
export function parseRadio(text: string, compounds: Record<string, string>): RadioIntent | null {
  const t = norm(text);
  const has = (re: RegExp) => re.test(t);
  if (has(/annull|non (mi )?fermo|niente (sosta|box)|resto fuori|rimango fuori|stiamo fuori|restiamo fuori/)) return { type: 'annullaBox' };
  // mescola nominata: "gomme dure", "metti le intermedie", "soft"
  const words: [RegExp, RegExp][] = [
    [/intermed|\binter\b|verdi/, /intermed/],
    [/morbid|soft|rosse/, /morbid/],
    [/\bmedi[ae]\b|medium|gialle/, /^medi/],
    [/\bdur[ae]\b|hard|bianche/, /dur/],
    [/bagnat|full ?wet|da pioggia|\bwet\b|blu/, /bagnat/],
  ];
  for (const [said, nameRe] of words) {
    if (!has(said)) continue;
    const id = Object.keys(compounds).find((k) => nameRe.test(norm(compounds[k])));
    // "come vanno le intermedie?" è una domanda sulle gomme, non un ordine
    if (id) return has(/come (vanno|sono|stanno)|quanto|stato/) ? { type: 'gomme' } : { type: 'mescola', compound: id };
  }
  if (has(/\b(ala|muso|alettone)\b/) && has(/cambi|ripar|nuov|sostitu/)) return { type: 'riparaAla' };
  if (has(/strategi|quando (mi fermo|devo (fermarmi|rientrare)|rientro)|piano gara|che facciamo/)) return { type: 'strategia' };
  if (has(/box,? box|rientro|rientriamo|entro ai box|entro in box|mi fermo|fermiamoci|vengo dentro|pit ?stop (questo|adesso|ora)|box (questo|adesso|ora)|sosta (questo|adesso|ora)/)) return { type: 'boxOra' };
  if (has(/gomm|pneumatic|usura|battistrad|temperatur/)) return { type: 'gomme' };
  if (has(/benzin|carburant|consum|\bfuel\b|serbatoi/)) return { type: 'benzina' };
  if (has(/batteri|\bers\b|energi|overtake|ibrid/)) return { type: 'batteria' };
  if (has(/dann|rott|come (va|sta) la (macchina|vettura|auto)|problem|guast/)) return { type: 'danni' };
  if (has(/meteo|pioggi|piov|nuvol|asciug|acqua|temporal|previsio/)) return { type: 'meteo' };
  if (has(/distacc|\bgap\b|dietro|davanti|posizion|quanti giri|mancano|chi (c'e|ho)|che posto/)) return { type: 'distacchi' };
  return null;
}

/** "Bip" della radio (due toni brevi + un soffio di disturbo) */
class RadioBeep {
  private ctx: AudioContext | null = null;
  play(volume: number): void {
    try {
      this.ctx ??= new AudioContext();
      const ctx = this.ctx;
      if (ctx.state === 'suspended') void ctx.resume();
      const t = ctx.currentTime;
      const g = ctx.createGain();
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12 * volume + 0.0001, t + 0.01);
      g.gain.setValueAtTime(0.12 * volume + 0.0001, t + 0.16);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      [1400, 1900].forEach((f, i) => {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f;
        o.connect(g);
        o.start(t + i * 0.08);
        o.stop(t + 0.08 + i * 0.08);
      });
      // fruscio
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const n = ctx.createBufferSource();
      n.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200;
      bp.Q.value = 0.8;
      const ng = ctx.createGain();
      ng.gain.value = 0.05 * volume;
      n.connect(bp).connect(ng).connect(ctx.destination);
      n.start(t + 0.16);
    } catch {
      /* audio non disponibile: pazienza */
    }
  }
}

export interface RadioOptions {
  voice: boolean;
  volume: number;
}

export class BoxRadio {
  private panel: HTMLDivElement;
  private menuEl: HTMLDivElement;
  private micEl: HTMLDivElement;
  private shown: Shown[] = [];
  private beep = new RadioBeep();
  private voiceIt: SpeechSynthesisVoice | null = null;
  menuOpen = false;
  private sel = 0;
  private menuTimer = 0;
  private items: MenuItem[];
  listening = false;
  private recog: { stop(): void; abort(): void } | null = null;
  private micTimer = 0;

  constructor(
    root: HTMLElement,
    /** domanda/ordine al box: Game risponde con say() */
    private ask: (i: RadioIntent, spoken: boolean) => void,
    /** mescole dell'auto (id → nome) e mescola scelta per la prossima sosta */
    private compounds: () => Record<string, string>,
    private plannedCompound: () => string,
    public opts: RadioOptions,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'hud-radio2';
    this.menuEl = document.createElement('div');
    this.menuEl.className = 'hud-panel radio-menu';
    this.micEl = document.createElement('div');
    this.micEl.className = 'hud-panel radio-mic';
    root.append(this.panel, this.menuEl, this.micEl);
    this.items = [
      { label: () => 'Come vanno le gomme?', intent: () => ({ type: 'gomme' }) },
      { label: () => 'Quanta benzina ho?', intent: () => ({ type: 'benzina' }) },
      { label: () => 'Distacchi e giri', intent: () => ({ type: 'distacchi' }) },
      { label: () => 'Meteo', intent: () => ({ type: 'meteo' }) },
      { label: () => 'Danni', intent: () => ({ type: 'danni' }) },
      { label: () => 'Strategia: quando mi fermo?', intent: () => ({ type: 'strategia' }) },
      { label: () => '<b>Box questo giro</b>', intent: () => ({ type: 'boxOra' }) },
      {
        label: () => `Mescola alla sosta: <b>${this.compounds()[this.plannedCompound()] ?? '–'}</b> ▸`,
        intent: () => {
          const ids = Object.keys(this.compounds());
          const next = ids[(ids.indexOf(this.plannedCompound()) + 1) % ids.length];
          return { type: 'mescola', compound: next };
        },
        keepOpen: true,
      },
      { label: () => 'Annulla la sosta', intent: () => ({ type: 'annullaBox' }) },
    ];
    this.loadVoice();
    if ('speechSynthesis' in window) speechSynthesis.addEventListener?.('voiceschanged', () => this.loadVoice());
  }

  private loadVoice(): void {
    if (!('speechSynthesis' in window)) return;
    const vs = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('it'));
    // preferenza: voci "naturali"/online (più realistiche), poi le altre italiane
    this.voiceIt = vs.find((v) => /natural|online|google/i.test(v.name)) ?? vs.find((v) => /diego|cosimo|luca|male/i.test(v.name)) ?? vs[0] ?? null;
  }

  /** Nuovo messaggio radio. */
  say(html: string, o: { from?: RadioFrom; prio?: RadioPrio; seconds?: number } = {}): void {
    const from = o.from ?? 'box';
    const prio = o.prio ?? (/<b>/.test(html) ? 'importante' : 'info');
    const el = document.createElement('div');
    el.className = `rmsg ${from} ${prio}`;
    const who = from === 'box' ? '📻 BOX' : from === 'tu' ? '🎙 TU' : '🏁 DIREZIONE GARA';
    el.innerHTML = `<div class="who">${who}</div><div class="txt">${html}</div>`;
    this.panel.prepend(el);
    this.shown.unshift({ el, ttl: o.seconds ?? (prio === 'info' ? 6 : 9) });
    // al massimo tre messaggi: i più vecchi spariscono
    while (this.shown.length > 3) this.shown.pop()!.el.remove();
    if (from !== 'tu' && prio !== 'info') this.speak(html, prio === 'urgente');
    else if (from !== 'tu') this.beep.play(this.opts.volume * 0.6);
  }

  /** Legge un messaggio ad alta voce (se la voce è attiva). */
  private speak(html: string, interrupt: boolean): void {
    this.beep.play(this.opts.volume);
    if (!this.opts.voice || !('speechSynthesis' in window)) return;
    const text = speakable(html);
    if (!text) return;
    // niente coda infinita: se il box sta già parlando di altro, l'ultimo messaggio vince
    if (interrupt || speechSynthesis.pending) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'it-IT';
    if (this.voiceIt) u.voice = this.voiceIt;
    u.rate = 1.12;
    u.pitch = 0.95;
    u.volume = Math.min(1, this.opts.volume);
    setTimeout(() => speechSynthesis.speak(u), 230); // dopo il bip
  }

  /** Zittisce la voce (pausa, fine sessione). */
  silence(): void {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  update(dt: number): void {
    for (const m of this.shown) {
      m.ttl -= dt;
      m.el.classList.toggle('fading', m.ttl < 0.8);
    }
    while (this.shown.length && this.shown[this.shown.length - 1].ttl <= 0) this.shown.pop()!.el.remove();
    if (this.menuOpen) {
      this.menuTimer -= dt;
      if (this.menuTimer <= 0) this.closeMenu();
    }
    if (this.micTimer > 0) {
      this.micTimer -= dt;
      if (this.micTimer <= 0 && !this.listening) this.micEl.style.display = 'none';
    }
  }

  // ---------------------------------------------------------------- menu

  toggleMenu(): void {
    if (this.menuOpen) this.pick(this.sel);
    else {
      this.menuOpen = true;
      this.sel = 0;
      this.menuTimer = 8;
      this.renderMenu();
    }
  }

  closeMenu(): void {
    this.menuOpen = false;
    this.menuEl.style.display = 'none';
  }

  move(delta: number): void {
    if (!this.menuOpen) return;
    this.sel = (this.sel + delta + this.items.length) % this.items.length;
    this.menuTimer = 8;
    this.renderMenu();
  }

  /** Sceglie la voce i (0..8). */
  pick(i: number): void {
    const it = this.items[i];
    if (!it) return;
    const intent = it.intent();
    if (it.keepOpen && this.menuOpen) {
      this.sel = i;
      this.menuTimer = 8;
      this.ask(intent, false);
      this.renderMenu();
      return;
    }
    this.closeMenu();
    this.say(it.label().replace(/<[^>]+>/g, '').replace(' ▸', ''), { from: 'tu', prio: 'info', seconds: 4 });
    this.ask(intent, false);
  }

  private renderMenu(): void {
    this.menuEl.style.display = 'block';
    this.menuEl.innerHTML = `<div class="title">📻 Radio box <small>1–9 · B conferma · volante: ▲▼ batteria, R2 conferma</small></div>` +
      this.items.map((it, i) => `<div class="item ${i === this.sel ? 'sel' : ''}"><span class="k">${i + 1}</span>${it.label()}</div>`).join('');
  }

  // ------------------------------------------------------- comandi vocali

  /** Avvia l'ascolto del microfono (una frase). */
  listen(onUnsupported: (why: string) => void): void {
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      onUnsupported('Il browser non riconosce la voce (serve Chrome o Edge): usa il menu radio (tasto B).');
      return;
    }
    if (this.listening) {
      this.recog?.stop();
      return;
    }
    this.silence();
    const r = new SR();
    r.lang = 'it-IT';
    r.interimResults = true;
    r.maxAlternatives = 3;
    r.continuous = false;
    this.listening = true;
    this.recog = r;
    this.showMic('🎙 Ti ascolto…', true);
    let done = false;
    r.onresult = (ev) => {
      const res = ev.results[ev.results.length - 1];
      const text = res[0].transcript;
      this.showMic(`🎙 «${text}»`, true);
      if (!res.isFinal || done) return;
      done = true;
      const alts = Array.from({ length: res.length }, (_, k) => res[k].transcript);
      let intent: RadioIntent | null = null;
      for (const a of alts) if ((intent = parseRadio(a, this.compounds()))) break;
      this.say(`«${text}»`, { from: 'tu', prio: 'info', seconds: 5 });
      if (intent) this.ask(intent, true);
      else this.say('Non ho capito, ripeti? Puoi chiedere gomme, benzina, distacchi, meteo, danni, strategia, oppure "box questo giro".', { prio: 'risposta' });
    };
    r.onerror = (ev) => {
      const why = ev.error === 'not-allowed' || ev.error === 'service-not-allowed'
        ? 'Microfono non consentito: permettilo nel browser (icona del lucchetto accanto all\'indirizzo).'
        : ev.error === 'network' ? 'Il riconoscimento vocale ha bisogno di internet.'
          : ev.error === 'no-speech' ? 'Non ho sentito niente.' : `Errore del microfono (${ev.error}).`;
      this.say(why, { prio: 'info', seconds: 5 });
    };
    r.onend = () => {
      this.listening = false;
      this.recog = null;
      this.micTimer = 1.2;
    };
    try {
      r.start();
    } catch {
      this.listening = false;
    }
  }

  private showMic(text: string, active: boolean): void {
    this.micEl.textContent = text;
    this.micEl.style.display = 'block';
    this.micEl.classList.toggle('on', active);
    this.micTimer = 3;
  }
}

/** Il minimo dell'API di riconoscimento vocale che usiamo (non è ancora nei tipi standard) */
interface SpeechRec {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
}
