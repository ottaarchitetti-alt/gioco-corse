/**
 * MODALITÀ CARRIERA — dati e regole (nessuna grafica qui).
 *
 * Il giocatore è un pilota di una scuderia e ne gestisce lo sviluppo:
 *  - 10 scuderie (modificabili), ognuna con un'auto di livello diverso:
 *      motore (potenza), aerodinamica (carico ed efficienza), telaio (aderenza meccanica),
 *      affidabilità (probabilità di guasto in gara);
 *  - piloti con abilità e aggressività (modificabili), 2 per scuderia;
 *  - un calendario di gare (modificabile) con weekend prove + qualifica + gara;
 *  - punti come in F1 (25-18-15-12-10-8-6-4-2-1), classifiche piloti e costruttori;
 *  - soldi: premi in base ai punti e sponsor in base al prestigio; si spendono per sviluppare
 *    l'auto tra una gara e l'altra (anche le altre scuderie si sviluppano);
 *  - obiettivo stagionale della scuderia (posizione tra i costruttori): a fine stagione,
 *    se superato arrivano offerte da scuderie migliori; se mancato, si rischia il posto.
 *
 * Le carriere sono salvate nel database del browser (IndexedDB, archivio 'careers').
 */
import { dbAll, dbDelete, dbGet, dbPut } from '../storage/db';
import type { BotSkill, Difficulty } from '../ai/BotDriver';
import { DIFFICULTIES } from '../ai/BotDriver';
import type { CarParams } from '../physics/CarParams';

// =====================================================================
//  TIPI
// =====================================================================

/** Livelli dell'auto di una scuderia (0..100) */
export interface CarLevels {
  motore: number;
  aero: number;
  telaio: number;
  affidabilita: number;
}
export const AREAS: { key: keyof CarLevels; label: string; help: string }[] = [
  { key: 'motore', label: 'Motore', help: 'più potenza: velocità in rettilineo e in uscita di curva' },
  { key: 'aero', label: 'Aerodinamica', help: 'più carico con meno resistenza: velocità nelle curve veloci' },
  { key: 'telaio', label: 'Telaio', help: 'più aderenza meccanica: curve lente, frenate, trazione' },
  { key: 'affidabilita', label: 'Affidabilità', help: 'meno guasti in gara' },
];

export interface Team {
  id: string;
  name: string;
  /** colore della livrea */
  color: string;
  car: CarLevels;
  /** prestigio 0..100: sponsor (soldi) e attrattiva per i piloti */
  prestige: number;
  /** cassa (milioni) */
  budget: number;
}

export interface Driver {
  id: string;
  name: string;
  number: number;
  /** abilità 0..100 */
  skill: number;
  /** aggressività 0..100 (sorpassi e difese) */
  aggression: number;
  teamId: string | null;
}

export interface CalendarRound {
  trackId: string;
  trackName: string;
  /** lunghezza della pista (m), per calcolare i giri */
  lengthM: number;
}

export type RaceLength = 'corta' | '25' | '50' | '100';
export const RACE_LENGTHS: Record<RaceLength, string> = { corta: 'Corta (5 giri)', 25: '25% (~75 km)', 50: '50% (~150 km)', 100: '100% (~305 km)' };

export interface ResultRow {
  driverId: string;
  teamId: string;
  pos: number;
  points: number;
  status: 'arrivato' | 'ritirato' | 'squalificato';
  /** giri di distacco dal vincitore (0 = a pieni giri) */
  lapsDown: number;
}

export interface RaceResult {
  round: number;
  trackName: string;
  /** griglia (id dei piloti in ordine di partenza) */
  grid: string[];
  rows: ResultRow[];
  /** guidata dal giocatore o simulata */
  simulated: boolean;
}

export interface Offer {
  teamId: string;
  /** obiettivo che ti chiederebbe (posizione tra i costruttori) */
  target: number;
}

export interface SeasonSummary {
  season: number;
  driversChampion: string;
  constructorsChampion: string;
  playerPos: number;
  teamPos: number;
  teamName: string;
  objective: number;
  met: boolean;
}

export interface Career {
  version: 1;
  id: string;
  name: string;
  created: number;
  /** auto usata (id del file in public/cars) */
  carClass: string;
  raceLength: RaceLength;
  difficulty: Difficulty;
  /** durata di prove e qualifica (minuti) */
  practiceMinutes: number;
  qualiMinutes: number;
  /** il giocatore è il pilota con id PLAYER_ID nella lista dei piloti */
  season: number;
  /** indice della prossima gara nel calendario */
  round: number;
  teams: Team[];
  drivers: Driver[];
  calendar: CalendarRound[];
  results: RaceResult[];
  /** obiettivo della tua scuderia: posizione nel campionato costruttori */
  objective: number;
  /** reputazione del pilota 0..100 (cresce con i risultati, conta per le offerte) */
  reputation: number;
  /** fine stagione: offerte ricevute (null = stagione in corso) */
  offers: Offer[] | null;
  history: SeasonSummary[];
  /** notizie (le più recenti per prime) */
  news: string[];
}

export const PLAYER_ID = 'pilota';
export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

// =====================================================================
//  DATI INIZIALI (nomi inventati: si possono cambiare tutti)
// =====================================================================

const TEAM_PRESETS: [string, string, number][] = [
  ['Scuderia Aurora', '#d8231f', 86],
  ['Vortex Racing', '#1f5fbf', 82],
  ['Falco Motorsport', '#f2c230', 76],
  ['Nordwind GP', '#16a6b6', 70],
  ['Fulmine Corse', '#e07020', 64],
  ['Atlas Engineering', '#2e9e4a', 58],
  ['Orione Racing', '#8e44ad', 52],
  ['Delta Speed', '#7f8c8d', 47],
  ['Gabbiano Team', '#ffffff', 42],
  ['Ferro Racing', '#2c3e50', 36],
];

const DRIVER_NAMES = [
  'M. Ferri', 'L. Conti', 'A. Greco', 'S. Marino', 'D. Galli', 'F. Riva', 'G. Testa', 'P. Fabbri',
  'E. Moretti', 'C. Barbieri', 'N. Lombardi', 'V. Colombo', 'T. Gentile', 'R. Fontana', 'I. Caruso',
  'O. Serra', 'B. Villa', 'U. Pellegrini', 'K. Sartori', 'H. Neri',
];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Scuderie e piloti di partenza. Il giocatore prende il posto di un pilota della scuderia scelta. */
export function defaultGrid(seed = 7): { teams: Team[]; drivers: Driver[] } {
  const r = rng(seed);
  const teams: Team[] = TEAM_PRESETS.map(([name, color, lvl], i) => {
    const j = () => Math.round(clamp(lvl + (r() - 0.5) * 12, 20, 98));
    return {
      id: `team_${i}`, name, color,
      car: { motore: j(), aero: j(), telaio: j(), affidabilita: Math.round(clamp(lvl + (r() - 0.5) * 20, 30, 98)) },
      prestige: Math.round(lvl),
      budget: Math.round(10 + lvl * 0.4),
    };
  });
  const drivers: Driver[] = DRIVER_NAMES.map((name, i) => {
    const team = teams[Math.floor(i / 2)];
    return {
      id: `drv_${i}`, name, number: i + 2,
      // i piloti migliori tendono a stare nelle scuderie migliori
      skill: Math.round(clamp(team.prestige * 0.6 + 30 + (r() - 0.5) * 20, 40, 99)),
      aggression: Math.round(30 + r() * 60),
      teamId: team.id,
    };
  });
  return { teams, drivers };
}

// =====================================================================
//  CREAZIONE E SALVATAGGIO
// =====================================================================

export interface NewCareerOptions {
  name: string;
  playerName: string;
  playerNumber: number;
  teamId: string;
  carClass: string;
  raceLength: RaceLength;
  difficulty: Difficulty;
  calendar: CalendarRound[];
  teams: Team[];
  drivers: Driver[];
}

export function newCareer(o: NewCareerOptions): Career {
  const drivers = o.drivers.map((d) => ({ ...d }));
  // il giocatore prende il posto del pilota meno forte della scuderia scelta
  const mates = drivers.filter((d) => d.teamId === o.teamId).sort((a, b) => a.skill - b.skill);
  if (mates.length >= 2) mates[0].teamId = null;
  drivers.push({ id: PLAYER_ID, name: o.playerName || 'Tu', number: o.playerNumber, skill: 0, aggression: 0, teamId: o.teamId });
  const c: Career = {
    version: 1,
    id: `car_${Date.now().toString(36)}`,
    name: o.name || 'Carriera',
    created: Date.now(),
    carClass: o.carClass,
    raceLength: o.raceLength,
    difficulty: o.difficulty,
    practiceMinutes: 10,
    qualiMinutes: 8,
    season: 1,
    round: 0,
    teams: o.teams.map((t) => ({ ...t, car: { ...t.car } })),
    drivers,
    calendar: o.calendar.map((r) => ({ ...r })),
    results: [],
    objective: 10,
    reputation: 40,
    offers: null,
    history: [],
    news: [],
  };
  c.objective = expectedRank(c, o.teamId);
  addNews(c, `Benvenuto in ${teamOf(c, o.teamId).name}! Obiettivo della stagione: ${ordinal(c.objective)} tra i costruttori.`);
  return c;
}

export const CareerStore = {
  async list(): Promise<Career[]> {
    const all = await dbAll<Career>('careers');
    return all.sort((a, b) => b.created - a.created);
  },
  load: (id: string) => dbGet<Career>('careers', id),
  save: (c: Career) => dbPut('careers', c.id, c),
  remove: (id: string) => dbDelete('careers', id),
};

// =====================================================================
//  AIUTI
// =====================================================================

export const teamOf = (c: Career, id: string | null): Team => c.teams.find((t) => t.id === id) ?? c.teams[0];
export const driverOf = (c: Career, id: string): Driver | undefined => c.drivers.find((d) => d.id === id);
export const playerDriver = (c: Career): Driver => c.drivers.find((d) => d.id === PLAYER_ID)!;
export const playerTeam = (c: Career): Team => teamOf(c, playerDriver(c).teamId);
export const ordinal = (n: number) => `${n}°`;
/** Piloti in gara (con una scuderia) */
export const racingDrivers = (c: Career): Driver[] => c.drivers.filter((d) => d.teamId && c.teams.some((t) => t.id === d.teamId));

export function addNews(c: Career, text: string): void {
  c.news.unshift(`S${c.season} · ${text}`);
  c.news.length = Math.min(c.news.length, 40);
}

/** Prestazione complessiva dell'auto (0..100): l'affidabilità conta poco sulla velocità */
export function carScore(l: CarLevels): number {
  return l.motore * 0.34 + l.aero * 0.36 + l.telaio * 0.3;
}

/** Posizione attesa tra i costruttori in base all'auto e ai piloti */
export function expectedRank(c: Career, teamId: string): number {
  const score = (t: Team) => {
    const ds = c.drivers.filter((d) => d.teamId === t.id && d.id !== PLAYER_ID).map((d) => d.skill);
    const drv = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 60;
    return carScore(t.car) * 0.75 + drv * 0.25;
  };
  const ranked = [...c.teams].sort((a, b) => score(b) - score(a));
  return ranked.findIndex((t) => t.id === teamId) + 1;
}

/** Giri della gara in base alla lunghezza scelta (gara vera ~305 km) */
export function raceLaps(c: Career, r: CalendarRound): number {
  if (c.raceLength === 'corta') return 5;
  const pct = parseInt(c.raceLength) / 100;
  return Math.max(3, Math.round((305000 * pct) / Math.max(1000, r.lengthM)));
}

// =====================================================================
//  CLASSIFICHE
// =====================================================================

export interface StandingRow {
  id: string;
  name: string;
  points: number;
  wins: number;
  podiums: number;
  best: number;
}

function tally(rows: { id: string; pts: number; pos: number }[], names: (id: string) => string): StandingRow[] {
  const m = new Map<string, StandingRow>();
  for (const r of rows) {
    const s = m.get(r.id) ?? { id: r.id, name: names(r.id), points: 0, wins: 0, podiums: 0, best: 99 };
    s.points += r.pts;
    if (r.pos === 1) s.wins++;
    if (r.pos <= 3) s.podiums++;
    s.best = Math.min(s.best, r.pos);
    m.set(r.id, s);
  }
  return [...m.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || b.podiums - a.podiums || a.best - b.best);
}

export function driverStandings(c: Career): StandingRow[] {
  const rows = c.results.flatMap((r) => r.rows.map((x) => ({ id: x.driverId, pts: x.points, pos: x.pos })));
  // anche chi non ha ancora corso compare in classifica (a 0 punti)
  for (const d of racingDrivers(c)) if (!rows.some((x) => x.id === d.id)) rows.push({ id: d.id, pts: 0, pos: 99 });
  return tally(rows, (id) => driverOf(c, id)?.name ?? id);
}

export function teamStandings(c: Career): StandingRow[] {
  const rows = c.results.flatMap((r) => r.rows.map((x) => ({ id: x.teamId, pts: x.points, pos: x.pos })));
  for (const t of c.teams) if (!rows.some((x) => x.id === t.id)) rows.push({ id: t.id, pts: 0, pos: 99 });
  return tally(rows, (id) => teamOf(c, id).name);
}

// =====================================================================
//  IN GARA: abilità dei bot e auto delle scuderie
// =====================================================================

/** Abilità del bot: livello di difficoltà scelto ± abilità del pilota */
export function botSkillOf(c: Career, d: Driver): BotSkill {
  const base = DIFFICULTIES[c.difficulty];
  const k = (d.skill - 70) / 100; // un pilota da 70 è "nella media" del livello
  return {
    grip: clamp(base.grip + k * 0.07, 0.75, 0.995),
    brake: clamp(base.brake + k * 0.07, 0.7, 0.98),
    inconsistency: clamp(base.inconsistency * (1 - k), 0.004, 0.05),
    errorRate: clamp(base.errorRate * (1 - k * 1.5), 0.003, 0.08),
    aggression: clamp(d.aggression / 100, 0, 1),
  };
}

/**
 * Applica i livelli della scuderia ai parametri dell'auto (stessa auto di base per tutti):
 *   motore ±6% di coppia, aerodinamica ±8% di carico e ∓3% di resistenza, telaio ±3% di aderenza.
 * Un livello 50 lascia l'auto com'è.
 */
export function applyCarLevels(car: CarParams, l: CarLevels): void {
  const m = (lv: number) => (lv - 50) / 50; // -1..+1
  const eng = 1 + 0.06 * m(l.motore);
  car.torqueCurve = car.torqueCurve.map(([rpm, nm]) => [rpm, nm * eng]);
  const down = 1 + 0.08 * m(l.aero), drag = 1 - 0.03 * m(l.aero);
  car.liftArea *= down;
  car.dragArea *= drag;
  if (car.activeAero) {
    car.activeAero = { ...car.activeAero, straightLiftArea: car.activeAero.straightLiftArea * down, straightDragArea: car.activeAero.straightDragArea * drag };
  }
  car.tire = { ...car.tire, mu: car.tire.mu * (1 + 0.03 * m(l.telaio)) };
}

/** Probabilità di un guasto in una gara intera (affidabilità 100 → 1%, 30 → ~10%) */
export function failureChance(l: CarLevels): number {
  return 0.01 + 0.13 * (1 - l.affidabilita / 100);
}

// =====================================================================
//  FINE GARA: punti, soldi, sviluppo delle altre scuderie
// =====================================================================

/** Premio (milioni) per i punti di una gara + sponsor fissi per gara in base al prestigio */
const PRIZE_PER_POINT = 0.12;
const sponsorPerRace = (t: Team) => 0.6 + t.prestige * 0.025;

/**
 * Registra il risultato di una gara: punti, soldi, reputazione, sviluppo automatico delle
 * altre scuderie, notizie. Passa alla gara successiva (o alla fine della stagione).
 * @param order id dei piloti nell'ordine d'arrivo (classificati prima, ritirati in fondo)
 */
export function recordRace(c: Career, rows: Omit<ResultRow, 'points' | 'pos' | 'teamId'>[], grid: string[], simulated: boolean): RaceResult {
  const r: RaceResult = {
    round: c.round,
    trackName: c.calendar[c.round]?.trackName ?? '',
    grid,
    simulated,
    rows: rows.map((x, i) => {
      const finished = x.status === 'arrivato';
      return { ...x, teamId: driverOf(c, x.driverId)?.teamId ?? '', pos: i + 1, points: finished && i < POINTS.length ? POINTS[i] : 0 };
    }),
  };
  c.results.push(r);

  // soldi: premi + sponsor
  for (const t of c.teams) {
    const pts = r.rows.filter((x) => x.teamId === t.id).reduce((a, x) => a + x.points, 0);
    t.budget = Math.round((t.budget + pts * PRIZE_PER_POINT + sponsorPerRace(t)) * 10) / 10;
  }
  // reputazione: cresce se vai meglio di quanto ci si aspetta dalla tua auto
  const me = r.rows.find((x) => x.driverId === PLAYER_ID);
  if (me) {
    const expected = expectedRank(c, playerTeam(c).id) * 2 - 0.5; // due piloti per scuderia
    const delta = me.status === 'arrivato' ? (expected - me.pos) * 0.6 : -1.5;
    c.reputation = Math.round(clamp(c.reputation + delta, 0, 100));
  }
  // le altre scuderie sviluppano l'auto (più soldi = più sviluppo, con un po' di fortuna)
  for (const t of c.teams) {
    if (t.id === playerTeam(c).id) continue;
    aiDevelop(t);
  }
  const win = r.rows[0];
  addNews(c, `${r.trackName}: vince ${driverOf(c, win.driverId)?.name ?? '?'} (${teamOf(c, win.teamId).name}).` +
    (me ? ` Tu: ${me.status === 'arrivato' ? ordinal(me.pos) : 'ritirato'}${me.points ? `, ${me.points} punti` : ''}.` : ''));
  c.round++;
  if (c.round >= c.calendar.length) endSeason(c);
  return r;
}

const devRng = Math.random;

/** Sviluppo automatico di una scuderia avversaria dopo una gara */
function aiDevelop(t: Team): void {
  // spende circa un terzo della cassa sopra una riserva di 4 milioni
  let spend = Math.max(0, (t.budget - 4) * 0.35);
  while (spend > 0.5) {
    const area = AREAS[Math.floor(devRng() * AREAS.length)].key;
    const cost = upgradeCost(t.car[area]);
    if (cost > spend) break;
    spend -= cost;
    t.budget = Math.round((t.budget - cost) * 10) / 10;
    t.car[area] = Math.min(100, t.car[area] + upgradeGain());
  }
}

// =====================================================================
//  SVILUPPO (la tua scuderia)
// =====================================================================

/** Costo (milioni) di un pacchetto di sviluppo: sale con il livello (più difficile migliorare) */
export function upgradeCost(level: number): number {
  return Math.round((1.5 + level * 0.06 + Math.max(0, level - 80) * 0.12) * 10) / 10;
}
/** Guadagno di un pacchetto: da +1 a +5 (non sempre lo sviluppo riesce bene) */
export function upgradeGain(): number {
  return 1 + Math.floor(devRng() * 5);
}

/** Compra un pacchetto di sviluppo per la tua scuderia. Restituisce il guadagno (o null se mancano i soldi). */
export function buyUpgrade(c: Career, area: keyof CarLevels): number | null {
  const t = playerTeam(c);
  const cost = upgradeCost(t.car[area]);
  if (t.budget < cost || t.car[area] >= 100) return null;
  const gain = Math.min(100 - t.car[area], upgradeGain());
  t.budget = Math.round((t.budget - cost) * 10) / 10;
  t.car[area] += gain;
  addNews(c, `Sviluppo ${AREAS.find((a) => a.key === area)!.label.toLowerCase()}: +${gain} (spesi ${cost.toFixed(1)} M).`);
  return gain;
}

// =====================================================================
//  FINE STAGIONE: obiettivo, offerte, nuova stagione
// =====================================================================

function endSeason(c: Career): void {
  const ds = driverStandings(c), ts = teamStandings(c);
  const myTeam = playerTeam(c);
  const teamPos = ts.findIndex((x) => x.id === myTeam.id) + 1;
  const playerPos = ds.findIndex((x) => x.id === PLAYER_ID) + 1;
  const met = teamPos <= c.objective;
  c.history.push({
    season: c.season, driversChampion: ds[0]?.name ?? '-', constructorsChampion: ts[0]?.name ?? '-',
    playerPos, teamPos, teamName: myTeam.name, objective: c.objective, met,
  });
  c.reputation = Math.round(clamp(c.reputation + (met ? 8 : -8) + (c.objective - teamPos) * 2, 0, 100));
  addNews(c, `Fine stagione: campione ${ds[0]?.name}, costruttori ${ts[0]?.name}. ${myTeam.name} ${ordinal(teamPos)} (obiettivo ${ordinal(c.objective)}): ${met ? 'obiettivo raggiunto!' : 'obiettivo mancato.'}`);

  // offerte: le scuderie che ti vogliono dipendono dalla reputazione
  const byRank = [...c.teams].sort((a, b) => expectedRank(c, a.id) - expectedRank(c, b.id));
  const myRank = byRank.findIndex((t) => t.id === myTeam.id);
  // fino a che posizione della "scala" puoi arrivare: reputazione alta = scuderie di vertice
  const reach = Math.round((1 - c.reputation / 100) * (byRank.length - 1));
  const offers: Offer[] = [];
  for (let i = 0; i < byRank.length && offers.length < 3; i++) {
    const t = byRank[i];
    if (t.id === myTeam.id) continue;
    if (i >= reach - 1 && i < myRank + (met ? 0 : 3)) offers.push({ teamId: t.id, target: i + 1 });
  }
  // la tua scuderia: rinnova se l'obiettivo è raggiunto (o mancato di poco)
  const renew = met || teamPos <= c.objective + 1;
  if (renew) offers.unshift({ teamId: myTeam.id, target: Math.max(1, expectedRank(c, myTeam.id)) });
  if (!offers.length) offers.push({ teamId: byRank[byRank.length - 1].id, target: byRank.length });
  c.offers = offers;
  if (!renew) addNews(c, `${myTeam.name} non ti rinnova il contratto: scegli una nuova scuderia.`);
}

/** Accetta un'offerta e inizia la nuova stagione. */
export function startNewSeason(c: Career, teamId: string): void {
  const me = playerDriver(c);
  const offer = c.offers?.find((o) => o.teamId === teamId);
  if (teamId !== me.teamId) {
    // scambio di sedile: il pilota meno forte della nuova scuderia va nella tua vecchia
    const mates = c.drivers.filter((d) => d.teamId === teamId && d.id !== PLAYER_ID).sort((a, b) => a.skill - b.skill);
    if (mates.length >= 2) mates[0].teamId = me.teamId;
    addNews(c, `Firmi con ${teamOf(c, teamId).name}!`);
    me.teamId = teamId;
  }
  c.season++;
  c.round = 0;
  c.results = [];
  c.offers = null;
  const r = rng(c.season * 97 + c.created);
  // nuovo regolamento: le auto si riavvicinano un po' (15% verso il livello medio)
  for (const t of c.teams) {
    for (const a of AREAS) t.car[a.key] = Math.round(t.car[a.key] * 0.85 + 55 * 0.15);
    t.prestige = Math.round(clamp(t.prestige * 0.8 + (100 - expectedRank(c, t.id) * 9) * 0.2, 10, 100));
  }
  // i piloti cambiano un po' (esperienza, età)
  for (const d of c.drivers) if (d.id !== PLAYER_ID) d.skill = Math.round(clamp(d.skill + (r() - 0.45) * 6, 30, 99));
  c.objective = offer?.target ?? expectedRank(c, teamId);
  addNews(c, `Stagione ${c.season}: obiettivo ${ordinal(c.objective)} tra i costruttori con ${playerTeam(c).name}.`);
}

// =====================================================================
//  GARA SIMULATA (se non vuoi guidare un weekend)
// =====================================================================

/** Simula una gara: passo = auto + pilota + un po' di caso; guasti secondo l'affidabilità. */
export function simulateRace(c: Career): { rows: Omit<ResultRow, 'points' | 'pos' | 'teamId'>[]; grid: string[] } {
  const ds = racingDrivers(c);
  const pace = (d: Driver, noise: number) => {
    const t = teamOf(c, d.teamId);
    const skill = d.id === PLAYER_ID ? 50 + c.reputation * 0.4 : d.skill;
    return carScore(t.car) * 0.7 + skill * 0.3 + (Math.random() - 0.5) * noise;
  };
  const grid = [...ds].sort((a, b) => pace(b, 8) - pace(a, 8)).map((d) => d.id);
  const race = ds.map((d) => {
    const failed = Math.random() < failureChance(teamOf(c, d.teamId).car);
    return { d, p: pace(d, 14) - grid.indexOf(d.id) * 0.25, failed };
  });
  race.sort((a, b) => (a.failed === b.failed ? b.p - a.p : a.failed ? 1 : -1));
  return {
    grid,
    rows: race.map((x) => ({ driverId: x.d.id, status: x.failed ? 'ritirato' as const : 'arrivato' as const, lapsDown: 0 })),
  };
}
