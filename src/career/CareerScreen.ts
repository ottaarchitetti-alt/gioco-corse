/**
 * Schermate della MODALITÀ CARRIERA (#/carriera):
 *   - elenco delle carriere salvate e creazione di una nuova;
 *   - pagina della carriera con schede: Panoramica, Classifiche, Calendario, Sviluppo,
 *     Scuderie (editor), Piloti (editor), Notizie;
 *   - fine stagione: riepilogo e offerte delle scuderie.
 */
import { listCars, type CarEntry } from '../physics/CarParams';
import { TrackStore, type TrackInfo } from '../storage/TrackStore';
import { DIFFICULTIES, type Difficulty } from '../ai/BotDriver';
import { navigate } from '../ui/router';
import {
  AREAS, CareerStore, PLAYER_ID, RACE_LENGTHS, buyUpgrade, carScore, defaultGrid, driverOf, driverStandings,
  expectedRank, failureChance, newCareer, ordinal, playerDriver, playerTeam, raceLaps, racingDrivers, recordRace,
  simulateRace, startNewSeason, teamOf, teamStandings, upgradeCost,
  type CalendarRound, type Career, type RaceLength, type Team,
} from './CareerData';

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (m: number) => `${m.toFixed(1).replace('.', ',')} M`;
const swatch = (color: string) => `<span class="swatch" style="background:${esc(color)}"></span>`;
const bar = (v: number, color = 'var(--accent)') => `<span class="lvl"><i style="width:${Math.max(0, Math.min(100, v))}%;background:${color}"></i></span>`;

/** Calendario proposto: 10 gare del calendario 2026 (si cambia nella scheda Calendario) */
const DEFAULT_ROUNDS = ['cal26_01_melbourne', 'cal26_04_sakhir', 'cal26_06_miami', 'cal26_08_monaco', 'cal26_09_barcellona',
  'cal26_11_silverstone', 'cal26_12_spa', 'cal26_15_monza', 'cal26_19_austin', 'cal26_21_interlagos'];

type Tab = 'panoramica' | 'classifiche' | 'calendario' | 'sviluppo' | 'scuderie' | 'piloti' | 'notizie';
const TABS: [Tab, string][] = [
  ['panoramica', '🏁 Panoramica'], ['classifiche', '🏆 Classifiche'], ['calendario', '📅 Calendario'],
  ['sviluppo', '🔧 Sviluppo'], ['scuderie', '🏎 Scuderie'], ['piloti', '👤 Piloti'], ['notizie', '📰 Notizie'],
];

export class CareerScreen {
  private el: HTMLDivElement;
  private career: Career | null = null;
  private tab: Tab = 'panoramica';
  private tracks: TrackInfo[] = [];
  private cars: CarEntry[] = [];
  private msg = '';

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'menu-page career';
    root.appendChild(this.el);
  }

  async show(id: string | null): Promise<void> {
    [this.tracks, this.cars] = await Promise.all([TrackStore.list(), listCars()]);
    if (id) {
      this.career = (await CareerStore.load(id)) ?? null;
      if (this.career) return this.renderCareer();
    }
    return this.renderList();
  }

  private async save(): Promise<void> {
    if (this.career) await CareerStore.save(this.career);
  }

  // =====================================================================
  //  ELENCO E NUOVA CARRIERA
  // =====================================================================

  private async renderList(): Promise<void> {
    const list = await CareerStore.list();
    this.el.innerHTML = `
      <div class="menu-card">
        <h1>🏆 Carriera</h1>
        <p class="sub">Corri per una scuderia, sviluppa l'auto, raggiungi gli obiettivi e conquista un posto nelle squadre migliori.</p>
        <div class="menu-toolbar">
          <button class="primary" data-act="nuova">+ Nuova carriera</button>
          <button data-act="menu">← Menu principale</button>
        </div>
        <ul class="track-list">${list.map((c) => {
          const t = c.teams.find((x) => x.id === c.drivers.find((d) => d.id === PLAYER_ID)?.teamId);
          return `<li class="track-row"><div class="track-name">${esc(c.name)}
            <span class="len">Stagione ${c.season} · gara ${Math.min(c.round + 1, c.calendar.length)}/${c.calendar.length} · ${t ? swatch(t.color) + esc(t.name) : ''}</span></div>
            <div class="track-actions"><button class="primary" data-act="apri" data-id="${c.id}">Continua</button>
            <button class="danger" data-act="elimina" data-id="${c.id}">Elimina</button></div></li>`;
        }).join('') || '<li class="empty">Nessuna carriera: creane una nuova.</li>'}</ul>
      </div>`;
    this.bindActs({
      nuova: () => this.renderNew(),
      menu: () => navigate('menu'),
      apri: (id) => navigate('carriera', { id: id! }),
      elimina: async (id) => {
        const c = list.find((x) => x.id === id);
        if (c && confirm(`Eliminare la carriera "${c.name}"? Non si può annullare.`)) {
          await CareerStore.remove(id!);
          void this.renderList();
        }
      },
    });
  }

  private renderNew(): void {
    const grid = defaultGrid(Date.now() % 1000);
    const avail = this.tracks.filter((t) => t.lengthM);
    const defaults = DEFAULT_ROUNDS.filter((id) => avail.some((t) => t.id === id));
    const f = {
      name: 'La mia carriera', player: 'Tu', number: 27, car: this.cars.find((c) => c.id === 'monoposto_2026')?.id ?? this.cars[0]?.id,
      length: '25' as RaceLength, diff: 'medio' as Difficulty, team: grid.teams[7].id,
      rounds: defaults.length ? defaults : avail.slice(0, 8).map((t) => t.id),
    };
    const byRank = [...grid.teams].sort((a, b) => carScore(b.car) - carScore(a.car));
    this.el.innerHTML = `
      <div class="menu-card">
        <h1>Nuova carriera</h1>
        <div class="form career-form">
          <label>Nome della carriera <input data-f="name" value="${esc(f.name)}"></label>
          <label>Il tuo nome <input data-f="player" value="${esc(f.player)}"></label>
          <label>Numero <input type="number" min="1" max="99" data-f="number" value="${f.number}"></label>
          <label>Auto <select data-f="car">${this.cars.map((c) => `<option value="${c.id}" ${c.id === f.car ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label>Durata delle gare <select data-f="length">${(Object.keys(RACE_LENGTHS) as RaceLength[]).map((k) => `<option value="${k}" ${k === f.length ? 'selected' : ''}>${RACE_LENGTHS[k]}</option>`).join('')}</select></label>
          <label>Difficoltà degli avversari <select data-f="diff">${(Object.keys(DIFFICULTIES) as Difficulty[]).map((k) => `<option value="${k}" ${k === f.diff ? 'selected' : ''}>${DIFFICULTIES[k].label}</option>`).join('')}</select></label>
        </div>
        <h2 class="career-h2">Scuderia di partenza</h2>
        <p class="hint">Le scuderie in fondo hanno auto più lente ma obiettivi più facili. Nomi, colori e livelli si cambiano dopo, nella scheda Scuderie.</p>
        <ul class="track-list">${byRank.map((t, i) => `
          <li class="track-row pick ${t.id === f.team ? 'on' : ''}" data-team="${t.id}">
            <div class="track-name">${swatch(t.color)}${esc(t.name)} <span class="len">auto ${Math.round(carScore(t.car))} · prevista ${ordinal(i + 1)}</span></div>
            <div class="track-actions">${bar(carScore(t.car))}</div></li>`).join('')}</ul>
        <h2 class="career-h2">Calendario</h2>
        <p class="hint">Spunta le piste della stagione (anche quelle create con l'editor). L'ordine si cambia dopo, nella scheda Calendario.</p>
        <div class="round-picks">${avail.map((t) => `<label class="row"><input type="checkbox" data-round="${t.id}" ${f.rounds.includes(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div>
        <div class="menu-toolbar"><button class="primary" data-act="crea">▶ Inizia la carriera</button><button data-act="indietro">Annulla</button></div>
        <p class="err">${this.msg}</p>
      </div>`;
    this.el.querySelectorAll<HTMLElement>('[data-team]').forEach((li) => li.addEventListener('click', () => {
      f.team = li.dataset.team!;
      this.el.querySelectorAll('[data-team]').forEach((x) => x.classList.toggle('on', x === li));
    }));
    this.bindActs({
      indietro: () => this.renderList(),
      crea: async () => {
        const val = (k: string) => (this.el.querySelector(`[data-f="${k}"]`) as HTMLInputElement).value;
        const picked = [...this.el.querySelectorAll<HTMLInputElement>('[data-round]')].filter((x) => x.checked).map((x) => x.dataset.round!);
        // mantiene l'ordine del calendario proposto, poi le altre piste nell'ordine dell'elenco
        const ordered = [...defaults.filter((id) => picked.includes(id)), ...picked.filter((id) => !defaults.includes(id))];
        if (!ordered.length) { this.msg = 'Scegli almeno una pista.'; return this.renderNew(); }
        const calendar: CalendarRound[] = ordered.map((id) => {
          const t = avail.find((x) => x.id === id)!;
          return { trackId: id, trackName: t.name, lengthM: t.lengthM ?? 4000 };
        });
        const c = newCareer({
          name: val('name'), playerName: val('player'), playerNumber: parseInt(val('number')) || 27, teamId: f.team,
          carClass: val('car'), raceLength: val('length') as RaceLength, difficulty: val('diff') as Difficulty,
          calendar, teams: grid.teams, drivers: grid.drivers,
        });
        await CareerStore.save(c);
        navigate('carriera', { id: c.id });
      },
    });
  }

  // =====================================================================
  //  PAGINA DELLA CARRIERA
  // =====================================================================

  private renderCareer(): void {
    const c = this.career!;
    const me = playerDriver(c), team = playerTeam(c);
    const ts = teamStandings(c);
    const teamPos = ts.findIndex((x) => x.id === team.id) + 1;
    this.el.innerHTML = `
      <div class="menu-card wide">
        <div class="career-head">
          <div><h1>${esc(c.name)}</h1>
            <p class="sub">${swatch(team.color)}<b>${esc(team.name)}</b> · ${esc(me.name)} #${me.number} · Stagione ${c.season} ·
            ${c.offers ? 'stagione finita' : `gara ${c.round + 1} di ${c.calendar.length}`}</p></div>
          <div class="career-kpi">
            <div><span>Cassa</span><b>${money(team.budget)}</b></div>
            <div><span>Obiettivo</span><b>${ordinal(c.objective)}</b></div>
            <div><span>Costruttori</span><b class="${teamPos <= c.objective ? 'good' : 'bad'}">${ordinal(teamPos)}</b></div>
            <div><span>Reputazione</span><b>${c.reputation}</b></div>
          </div>
        </div>
        <div class="segs career-tabs">${TABS.map(([k, l]) => `<button class="seg ${this.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
        <p class="msg">${this.msg}</p>
        <div class="career-body">${this.tabHtml()}</div>
        <div class="menu-toolbar"><button data-act="carriere">← Le mie carriere</button><button data-act="menu">Menu principale</button></div>
      </div>`;
    this.msg = '';
    this.el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { this.tab = b.dataset.tab as Tab; this.renderCareer(); }));
    this.bindActs({
      carriere: () => navigate('carriera'),
      menu: () => navigate('menu'),
      weekend: () => {
        const r = c.calendar[c.round];
        navigate('guida', { pista: r.trackId, carriera: c.id, auto: c.carClass });
      },
      simula: async () => {
        if (!confirm('Simulare questa gara senza guidare? Il risultato dipende da auto, piloti e un po\' di fortuna.')) return;
        const sim = simulateRace(c);
        recordRace(c, sim.rows, sim.grid, true);
        await this.save();
        this.renderCareer();
      },
      firma: async (id) => {
        startNewSeason(c, id!);
        await this.save();
        this.tab = 'panoramica';
        this.renderCareer();
      },
      sviluppa: async (area) => {
        const gain = buyUpgrade(c, area as keyof Team['car']);
        this.msg = gain === null ? 'Soldi insufficienti per questo sviluppo.' : `Sviluppo riuscito: +${gain}.`;
        await this.save();
        this.renderCareer();
      },
    });
    this.bindEditors();
  }

  private tabHtml(): string {
    switch (this.tab) {
      case 'panoramica': return this.overviewHtml();
      case 'classifiche': return this.standingsHtml();
      case 'calendario': return this.calendarHtml();
      case 'sviluppo': return this.developHtml();
      case 'scuderie': return this.teamsHtml();
      case 'piloti': return this.driversHtml();
      case 'notizie': return `<ul class="news">${this.career!.news.map((n) => `<li>${esc(n)}</li>`).join('') || '<li>Nessuna notizia.</li>'}</ul>`;
    }
  }

  private overviewHtml(): string {
    const c = this.career!;
    const team = playerTeam(c);
    if (c.offers) return this.seasonEndHtml();
    const r = c.calendar[c.round];
    const last = c.results[c.results.length - 1];
    const ds = driverStandings(c).slice(0, 5), ts = teamStandings(c).slice(0, 5);
    return `
      <div class="career-grid">
        <div class="ccard">
          <h3>Prossima gara · ${c.round + 1}/${c.calendar.length}</h3>
          <p class="big">${esc(r.trackName)}</p>
          <p>${raceLaps(c, r)} giri · prove ${c.practiceMinutes}' · qualifica ${c.qualiMinutes}'</p>
          <p class="hint">Rischio guasto della tua auto: ${(failureChance(team.car) * 100).toFixed(0)}% a gara.</p>
          <div class="menu-toolbar"><button class="primary" data-act="weekend">▶ Vai al weekend</button><button data-act="simula">Simula la gara</button></div>
        </div>
        <div class="ccard">
          <h3>Ultima gara</h3>
          ${last ? `<p><b>${esc(last.trackName)}</b>${last.simulated ? ' (simulata)' : ''}</p>${this.resultTable(last.rows.slice(0, 10))}` : '<p class="hint">Nessuna gara ancora disputata.</p>'}
        </div>
        <div class="ccard"><h3>Piloti</h3>${this.standTable(ds, true)}</div>
        <div class="ccard"><h3>Costruttori</h3>${this.standTable(ts, false)}</div>
      </div>`;
  }

  private seasonEndHtml(): string {
    const c = this.career!;
    const h = c.history[c.history.length - 1];
    return `
      <div class="ccard">
        <h3>Fine della stagione ${h.season}</h3>
        <p>Campione piloti: <b>${esc(h.driversChampion)}</b> · Costruttori: <b>${esc(h.constructorsChampion)}</b></p>
        <p>Tu: ${ordinal(h.playerPos)} tra i piloti · ${esc(h.teamName)} ${ordinal(h.teamPos)} tra i costruttori (obiettivo ${ordinal(h.objective)}):
          <b class="${h.met ? 'good' : 'bad'}">${h.met ? 'obiettivo raggiunto' : 'obiettivo mancato'}</b> · reputazione ${c.reputation}</p>
        <h3>Offerte per la prossima stagione</h3>
        <ul class="track-list">${c.offers!.map((o) => {
          const t = teamOf(c, o.teamId);
          return `<li class="track-row"><div class="track-name">${swatch(t.color)}${esc(t.name)}
            <span class="len">auto ${Math.round(carScore(t.car))} · obiettivo ${ordinal(o.target)} · cassa ${money(t.budget)}${t.id === playerTeam(c).id ? ' · rinnovo' : ''}</span></div>
            <div class="track-actions">${bar(carScore(t.car))}<button class="primary" data-act="firma" data-id="${t.id}">Firma</button></div></li>`;
        }).join('')}</ul>
      </div>`;
  }

  private resultTable(rows: Career['results'][number]['rows']): string {
    const c = this.career!;
    return `<table class="results"><tr><th>Pos</th><th>Pilota</th><th>Scuderia</th><th>Punti</th></tr>${rows.map((x) => `
      <tr class="${x.driverId === PLAYER_ID ? 'me' : ''}"><td>${x.status === 'arrivato' ? x.pos : 'Rit.'}</td><td>${esc(driverOf(c, x.driverId)?.name ?? x.driverId)}</td>
      <td>${swatch(teamOf(c, x.teamId).color)}${esc(teamOf(c, x.teamId).name)}</td><td>${x.points || ''}</td></tr>`).join('')}</table>`;
  }

  private standTable(rows: ReturnType<typeof driverStandings>, drivers: boolean): string {
    const c = this.career!;
    const myTeam = playerTeam(c).id;
    return `<table class="results"><tr><th>Pos</th><th>${drivers ? 'Pilota' : 'Scuderia'}</th><th>Punti</th><th>Vitt.</th></tr>${rows.map((s, i) => {
      const me = drivers ? s.id === PLAYER_ID : s.id === myTeam;
      const col = drivers ? teamOf(c, driverOf(c, s.id)?.teamId ?? null).color : teamOf(c, s.id).color;
      return `<tr class="${me ? 'me' : ''}"><td>${i + 1}</td><td>${swatch(col)}${esc(s.name)}</td><td>${s.points}</td><td>${s.wins || ''}</td></tr>`;
    }).join('')}</table>`;
  }

  private standingsHtml(): string {
    const c = this.career!;
    return `<div class="career-grid"><div class="ccard"><h3>Piloti</h3>${this.standTable(driverStandings(c), true)}</div>
      <div class="ccard"><h3>Costruttori</h3>${this.standTable(teamStandings(c), false)}</div></div>
      ${c.history.length ? `<div class="ccard"><h3>Stagioni passate</h3><table class="results"><tr><th>Stagione</th><th>Campione</th><th>Costruttori</th><th>Tu</th><th>Scuderia</th></tr>
        ${c.history.map((h) => `<tr><td>${h.season}</td><td>${esc(h.driversChampion)}</td><td>${esc(h.constructorsChampion)}</td><td>${ordinal(h.playerPos)}</td><td>${esc(h.teamName)} ${ordinal(h.teamPos)} ${h.met ? '✔' : '✘'}</td></tr>`).join('')}</table></div>` : ''}`;
  }

  private calendarHtml(): string {
    const c = this.career!;
    const avail = this.tracks.filter((t) => t.lengthM);
    return `<div class="ccard"><h3>Calendario della stagione ${c.season}</h3>
      <table class="results"><tr><th>#</th><th>Pista</th><th>Giri</th><th>Vincitore</th><th>Tu</th><th></th></tr>
      ${c.calendar.map((r, i) => {
        const res = c.results.find((x) => x.round === i);
        const me = res?.rows.find((x) => x.driverId === PLAYER_ID);
        const future = i > c.round || (i === c.round && !c.offers);
        return `<tr class="${i === c.round && !c.offers ? 'me' : ''}"><td>${i + 1}</td><td>${esc(r.trackName)}</td><td>${raceLaps(c, r)}</td>
          <td>${res ? esc(driverOf(c, res.rows[0].driverId)?.name ?? '') : ''}</td><td>${me ? (me.status === 'arrivato' ? ordinal(me.pos) : 'Rit.') : ''}</td>
          <td>${future ? `<button class="mini" data-cal="su" data-i="${i}" ${i <= c.round ? 'disabled' : ''}>▲</button><button class="mini" data-cal="giu" data-i="${i}" ${i <= c.round || i === c.calendar.length - 1 ? 'disabled' : ''}>▼</button><button class="mini danger" data-cal="via" data-i="${i}" ${c.calendar.length <= 1 ? 'disabled' : ''}>✕</button>` : ''}</td></tr>`;
      }).join('')}</table>
      ${c.offers ? '' : `<div class="form inline"><label>Aggiungi una gara <select data-cal-add>${avail.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
        <button data-cal="aggiungi">+ Aggiungi in fondo</button></div>`}
      <div class="form inline"><label>Durata gare <select data-opt="raceLength">${(Object.keys(RACE_LENGTHS) as RaceLength[]).map((k) => `<option value="${k}" ${k === c.raceLength ? 'selected' : ''}>${RACE_LENGTHS[k]}</option>`).join('')}</select></label>
        <label>Prove (min) <input type="number" min="0" max="60" data-opt="practiceMinutes" value="${c.practiceMinutes}"></label>
        <label>Qualifica (min) <input type="number" min="3" max="30" data-opt="qualiMinutes" value="${c.qualiMinutes}"></label>
        <label>Difficoltà <select data-opt="difficulty">${(Object.keys(DIFFICULTIES) as Difficulty[]).map((k) => `<option value="${k}" ${k === c.difficulty ? 'selected' : ''}>${DIFFICULTIES[k].label}</option>`).join('')}</select></label></div>
      <p class="hint">Le gare già disputate non si possono spostare. Prove a 0 minuti = si parte dalla qualifica.</p></div>`;
  }

  private developHtml(): string {
    const c = this.career!;
    const t = playerTeam(c);
    const best = Object.fromEntries(AREAS.map((a) => [a.key, Math.max(...c.teams.map((x) => x.car[a.key]))]));
    return `<div class="ccard"><h3>Sviluppo di ${swatch(t.color)}${esc(t.name)} · cassa ${money(t.budget)}</h3>
      <p class="hint">Ogni pacchetto migliora l'area da +1 a +5 (lo sviluppo non riesce sempre allo stesso modo). Più il livello è alto, più costa.
      Dopo ogni gara arrivano premi (in base ai punti) e sponsor (in base al prestigio); anche le altre scuderie sviluppano.</p>
      <table class="results dev"><tr><th>Area</th><th>Livello</th><th></th><th>Migliore</th><th>Costo</th><th></th></tr>
      ${AREAS.map((a) => {
        const lv = t.car[a.key], cost = upgradeCost(lv);
        return `<tr><td><b>${a.label}</b><br><small>${a.help}</small></td><td>${lv}</td><td>${bar(lv)}</td><td>${best[a.key]}</td><td>${money(cost)}</td>
          <td><button class="primary" data-act="sviluppa" data-id="${a.key}" ${t.budget < cost || lv >= 100 ? 'disabled' : ''}>Sviluppa</button></td></tr>`;
      }).join('')}</table>
      <p>Prestazione dell'auto: <b>${Math.round(carScore(t.car))}</b> · posizione prevista ${ordinal(expectedRank(c, t.id))} · rischio guasto ${(failureChance(t.car) * 100).toFixed(0)}% a gara</p></div>`;
  }

  // ---------------------------------------------------------------- editor

  private teamsHtml(): string {
    const c = this.career!;
    return `<div class="ccard"><h3>Scuderie</h3>
      <p class="hint">Modifica nome, colore e livelli dell'auto (0–100). Le modifiche valgono dalla prossima gara.</p>
      <table class="results edit"><tr><th>Colore</th><th>Nome</th>${AREAS.map((a) => `<th>${a.label}</th>`).join('')}<th>Prestigio</th><th>Cassa</th><th>Piloti</th><th></th></tr>
      ${c.teams.map((t, i) => `<tr${t.id === playerTeam(c).id ? ' class="me"' : ''}>
        <td><input type="color" data-team-f="color" data-i="${i}" value="${esc(t.color)}"></td>
        <td><input data-team-f="name" data-i="${i}" value="${esc(t.name)}"></td>
        ${AREAS.map((a) => `<td><input type="number" min="0" max="100" data-team-f="${a.key}" data-i="${i}" value="${t.car[a.key]}"></td>`).join('')}
        <td><input type="number" min="0" max="100" data-team-f="prestige" data-i="${i}" value="${t.prestige}"></td>
        <td><input type="number" min="0" max="500" step="0.5" data-team-f="budget" data-i="${i}" value="${t.budget}"></td>
        <td>${c.drivers.filter((d) => d.teamId === t.id).length}</td>
        <td>${t.id === playerTeam(c).id ? '' : `<button class="mini danger" data-team-del="${i}">✕</button>`}</td></tr>`).join('')}</table>
      <button data-team-add ${c.teams.length >= 12 ? 'disabled' : ''}>+ Nuova scuderia</button>
      <p class="hint">In gara corrono al massimo 20 auto (2 per scuderia è l'ideale). Eliminando una scuderia i suoi piloti restano liberi.</p></div>`;
  }

  private driversHtml(): string {
    const c = this.career!;
    const racing = racingDrivers(c).length;
    const teamOpts = (sel: string | null) => `<option value="">— libero —</option>${c.teams.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}`;
    return `<div class="ccard"><h3>Piloti · ${racing} in gara${racing > 20 ? ' <span class="bad">(troppi: in gara entrano i primi 20)</span>' : ''}</h3>
      <p class="hint">Abilità e aggressività 0–100. Ogni scuderia dovrebbe avere 2 piloti. Il tuo pilota è evidenziato.</p>
      <table class="results edit"><tr><th>Nome</th><th>Numero</th><th>Abilità</th><th>Aggressività</th><th>Scuderia</th><th></th></tr>
      ${c.drivers.map((d, i) => {
        const me = d.id === PLAYER_ID;
        return `<tr class="${me ? 'me' : ''}"><td><input data-drv-f="name" data-i="${i}" value="${esc(d.name)}"></td>
          <td><input type="number" min="1" max="99" data-drv-f="number" data-i="${i}" value="${d.number}"></td>
          <td>${me ? '—' : `<input type="number" min="0" max="100" data-drv-f="skill" data-i="${i}" value="${d.skill}">`}</td>
          <td>${me ? '—' : `<input type="number" min="0" max="100" data-drv-f="aggression" data-i="${i}" value="${d.aggression}">`}</td>
          <td>${me ? esc(playerTeam(c).name) : `<select data-drv-f="teamId" data-i="${i}">${teamOpts(d.teamId)}</select>`}</td>
          <td>${me ? '' : `<button class="mini danger" data-drv-del="${i}">✕</button>`}</td></tr>`;
      }).join('')}</table>
      <button data-drv-add>+ Nuovo pilota</button></div>`;
  }

  private bindEditors(): void {
    const c = this.career!;
    const changed = async (rerender = false) => {
      await this.save();
      if (rerender) this.renderCareer();
    };
    // scuderie
    this.el.querySelectorAll<HTMLInputElement>('[data-team-f]').forEach((inp) => inp.addEventListener('change', () => {
      const t = c.teams[parseInt(inp.dataset.i!)];
      const k = inp.dataset.teamF!;
      if (k === 'name') t.name = inp.value || t.name;
      else if (k === 'color') t.color = inp.value;
      else if (k === 'prestige') t.prestige = clampInt(inp.value, 0, 100);
      else if (k === 'budget') t.budget = Math.max(0, parseFloat(inp.value) || 0);
      else t.car[k as keyof Team['car']] = clampInt(inp.value, 0, 100);
      void changed();
    }));
    this.el.querySelectorAll<HTMLButtonElement>('[data-team-del]').forEach((b) => b.addEventListener('click', () => {
      const t = c.teams[parseInt(b.dataset.teamDel!)];
      if (!confirm(`Eliminare la scuderia "${t.name}"? I suoi piloti restano liberi.`)) return;
      c.drivers.forEach((d) => { if (d.teamId === t.id) d.teamId = null; });
      c.teams = c.teams.filter((x) => x !== t);
      void changed(true);
    }));
    this.el.querySelector('[data-team-add]')?.addEventListener('click', () => {
      c.teams.push({ id: `team_${Date.now().toString(36)}`, name: 'Nuova scuderia', color: '#888888', car: { motore: 50, aero: 50, telaio: 50, affidabilita: 60 }, prestige: 40, budget: 20 });
      void changed(true);
    });
    // piloti
    this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-drv-f]').forEach((inp) => inp.addEventListener('change', () => {
      const d = c.drivers[parseInt(inp.dataset.i!)];
      const k = inp.dataset.drvF!;
      if (k === 'name') d.name = inp.value || d.name;
      else if (k === 'teamId') d.teamId = inp.value || null;
      else if (k === 'number') d.number = clampInt(inp.value, 1, 99);
      else (d as unknown as Record<string, number>)[k] = clampInt(inp.value, 0, 100);
      void changed(k === 'teamId');
    }));
    this.el.querySelectorAll<HTMLButtonElement>('[data-drv-del]').forEach((b) => b.addEventListener('click', () => {
      const d = c.drivers[parseInt(b.dataset.drvDel!)];
      if (!confirm(`Eliminare il pilota "${d.name}"?`)) return;
      c.drivers = c.drivers.filter((x) => x !== d);
      void changed(true);
    }));
    this.el.querySelector('[data-drv-add]')?.addEventListener('click', () => {
      c.drivers.push({ id: `drv_${Date.now().toString(36)}`, name: 'Nuovo pilota', number: 99, skill: 60, aggression: 50, teamId: null });
      void changed(true);
    });
    // calendario
    this.el.querySelectorAll<HTMLButtonElement>('[data-cal]').forEach((b) => b.addEventListener('click', () => {
      const i = parseInt(b.dataset.i ?? '-1');
      const cal = c.calendar;
      switch (b.dataset.cal) {
        case 'su': if (i > c.round) [cal[i - 1], cal[i]] = [cal[i], cal[i - 1]]; break;
        case 'giu': if (i < cal.length - 1) [cal[i + 1], cal[i]] = [cal[i], cal[i + 1]]; break;
        case 'via': if (cal.length > 1 && i >= c.round) cal.splice(i, 1); break;
        case 'aggiungi': {
          const id = (this.el.querySelector('[data-cal-add]') as HTMLSelectElement).value;
          const t = this.tracks.find((x) => x.id === id);
          if (t) cal.push({ trackId: t.id, trackName: t.name, lengthM: t.lengthM ?? 4000 });
          break;
        }
      }
      void changed(true);
    }));
    this.el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-opt]').forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.dataset.opt!;
      if (k === 'raceLength') c.raceLength = inp.value as RaceLength;
      else if (k === 'difficulty') c.difficulty = inp.value as Difficulty;
      else if (k === 'practiceMinutes') c.practiceMinutes = clampInt(inp.value, 0, 60);
      else if (k === 'qualiMinutes') c.qualiMinutes = clampInt(inp.value, 3, 30);
      void changed(true);
    }));
  }

  private bindActs(acts: Record<string, (id?: string) => void | Promise<void>>): void {
    this.el.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) =>
      b.addEventListener('click', () => void acts[b.dataset.act!]?.(b.dataset.id)),
    );
  }
}

function clampInt(v: string, a: number, b: number): number {
  return Math.max(a, Math.min(b, Math.round(parseFloat(v) || 0)));
}
