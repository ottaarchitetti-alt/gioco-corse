/**
 * Menu principale: elenco piste, guida, editor, importa/esporta.
 */
import { downloadTrack, pickTrackFile, TrackStore, type TrackInfo } from '../storage/TrackStore';
import { newTrack } from '../track/TrackData';
import { navigate } from './router';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class MainMenu {
  private el: HTMLDivElement;

  constructor(private root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'menu-page';
    root.appendChild(this.el);
  }

  async show(): Promise<void> {
    let tracks: TrackInfo[] = [];
    let error = '';
    try {
      tracks = await TrackStore.list();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const rows = tracks.map((t) => `
      <li class="track-row">
        <div class="track-name">${esc(t.name)} ${t.builtin ? '<span class="badge">inclusa</span>' : ''}</div>
        <div class="track-actions">
          <button class="primary" data-act="guida" data-id="${t.id}">Guida</button>
          ${t.builtin
            ? `<button data-act="duplica" data-id="${t.id}">Copia e modifica</button>`
            : `<button data-act="modifica" data-id="${t.id}">Modifica</button>
               <button data-act="duplica" data-id="${t.id}">Duplica</button>`}
          <button data-act="esporta" data-id="${t.id}">Esporta</button>
          ${t.builtin ? '' : `<button class="danger" data-act="elimina" data-id="${t.id}">Elimina</button>`}
        </div>
      </li>`).join('');

    this.el.innerHTML = `
      <div class="menu-card">
        <h1>Simulatore di corsa</h1>
        <p class="sub">Prove libere · scegli una pista o creane una nuova</p>
        <div class="menu-toolbar">
          <button class="primary" data-act="nuova">+ Nuova pista</button>
          <button data-act="importa">Importa pista (.json)</button>
        </div>
        ${error ? `<p class="err">${esc(error)}</p>` : ''}
        <ul class="track-list">${rows || '<li class="empty">Nessuna pista</li>'}</ul>
        <p class="hint">Le tue piste sono salvate in questo browser. Per conservarle o condividerle usa "Esporta".</p>
      </div>`;

    this.el.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) =>
      b.addEventListener('click', () => this.action(b.dataset.act!, b.dataset.id)),
    );
  }

  private async action(act: string, id?: string): Promise<void> {
    try {
      switch (act) {
        case 'guida':
          return navigate('guida', { pista: id! });
        case 'modifica':
          return navigate('editor', { pista: id! });
        case 'nuova': {
          const t = newTrack(TrackStore.newId(), 'Nuova pista');
          await TrackStore.save(t);
          return navigate('editor', { pista: t.id });
        }
        case 'duplica': {
          const t = await TrackStore.load(id!);
          t.id = TrackStore.newId();
          t.name = `${t.name} (copia)`;
          await TrackStore.save(t);
          return navigate('editor', { pista: t.id });
        }
        case 'esporta':
          return downloadTrack(await TrackStore.load(id!));
        case 'importa': {
          const t = await pickTrackFile();
          await TrackStore.save(t);
          return void this.show();
        }
        case 'elimina': {
          const t = await TrackStore.load(id!);
          if (!confirm(`Eliminare definitivamente la pista "${t.name}"?\nL'operazione non si può annullare (se ti serve, esportala prima).`)) return;
          await TrackStore.remove(id!);
          return void this.show();
        }
      }
    } catch (e) {
      alert(`Errore: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  dispose(): void {
    this.root.removeChild(this.el);
  }
}
