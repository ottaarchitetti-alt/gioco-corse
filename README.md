# Simulatore di corsa (browser)

Simulatore di guida in Three.js + TypeScript. Focus su abilità di guida e strategia.

## Avvio
Serve [Node.js](https://nodejs.org) (già installato su questo PC).

```powershell
npm install      # solo la prima volta
npm run dev      # avvia il gioco su http://localhost:5173
```
Se PowerShell risponde "l'esecuzione di script è disabilitata", usa `npm.cmd run dev`
oppure fai doppio clic su **avvia.bat**.

Apri l'indirizzo nel browser (Chrome o Edge consigliati, anche per il volante).

Altri comandi: `npm run typecheck` (controllo errori), `npm run build` (versione finale in `dist/`).

## Stato: fasi 1–14 completate
Il meteo è stato rimandato come deciso all'inizio (D11). Piste piatte (D7, D18).

### Fasi 9–14 — calendario 2026 e monoposto
**Piste (Fase 9).** Le 24 piste del calendario 2026 sono incluse (menu → "Calendario 2026").
Sono ricavate dai tracciati aperti del progetto f1-circuits (licenza MIT, vedi
`public/tracks/LICENZE.md`) con lo script `tools/converti_circuiti.py`: lunghezza ufficiale,
senso di marcia, traguardo, settori, corsia box e tribune generate in automatico.
Si possono copiare e modificare nell'editor. Limiti: piste piatte; a Suzuka l'incrocio del
"8" è a raso (in realtà è un ponte); i dati originali hanno pochi punti nelle curve, quindi
alcune curve sono più strette del vero e i tempi sul giro sono più alti di quelli reali.

**Monoposto 2026 (Fasi 10–13).** Nella schermata della sessione si sceglie la vettura
(tutta la griglia usa la stessa: una sola classe, D20).
- Modello 3D segnaposto: ruote scoperte con la fascia colorata della mescola, halo,
  pance, ali con flap mobili, sospensioni; camera abitacolo e T-cam (tasto C)
- Fisica: 768 kg, V6 turbo ~400 kW + motore elettrico 350 kW, 8 marce, freni carbonio,
  sospensioni rigide, gomme da monoposto (morbida/media/dura con fasce rossa/gialla/bianca)
- **Aerodinamica attiva**: nelle zone (rettilinei lunghi) a gas pieno le ali si aprono
  (meno resistenza e meno carico), in frenata si richiudono. HUD: "ZONA ALI" / "ALI APERTE"
- **Effetto suolo**: il carico cresce abbassando l'auto; se il fondo tocca terra lo perde.
  Altezza da terra regolabile nell'assetto
- **Ibrido (ERS)**: batteria da 4 MJ; recupero in frenata e in rilascio, "super clipping" a
  fine rettilineo; spinta elettrica che cala sopra i 290 km/h. Modalità batteria (tasto **K**):
  bilanciata, attacco, ricarica
- **Overtake mode** (tasto **O**): se al traguardo eri entro 1 s da chi ti precede, nel giro
  dopo hai spinta piena fino a 337 km/h e 0,5 MJ in più
- Regole: niente rifornimento (la benzina deve bastare), pit stop ~4 s, obbligo di usare
  due mescole in gara (da 5 giri in su), altrimenti squalifica
- Bot: traiettoria e velocità con deportanza, zone di aerodinamica attiva e spinta elettrica;
  usano subito l'Overtake mode; più prudenti al via e quando sono affiancati
- Volante G29: tasto X = Overtake, cerchio = modalità batteria. Per la monoposto imposta in
  G HUB **360°** di rotazione (la GT usa 540°)

Correzione importante per tutte le auto: la traiettoria ideale dei bot usava troppo pochi
punti sulle piste lunghe; ora sfrutta tutta la larghezza della pista (bot più veloci).

**Aiuti alla guida.**
- **Minimappa** in alto a destra: tracciato, traguardo, corsia box, avversari (puntini colorati)
  e la tua auto (freccia bianca). Si nasconde quando apri la telemetria (T) o l'elenco giri (L).
- **Cartelli di frenata** 300/200/100/50/25 m prima delle curve, generati su tutte le piste.
- **Flashback** (prove, qualifica e gara: in gara tornano indietro anche tutti gli avversari): **Backspace** (gamepad A, G29 quadrato) torna indietro
  di 3 s; ogni pressione altri 3 s (fino a 20 s); premi l'acceleratore per ripartire. Si torna
  esattamente a quel momento: se il giro era valido resta valido (un'uscita di pista o una
  penalità presa dopo viene cancellata).

**ABS e bot più puliti.** L'ABS ora impedisce davvero il bloccaggio delle ruote (prima, con i
freni potenti della monoposto, le ruote anteriori si bloccavano anche con l'ABS attivo); sulle
posteriori toglie anche il freno motore. I bot non sterzano oltre l'aderenza disponibile (ma
controsterzano quanto serve), danno gas in modo progressivo, correggono in anticipo quando si
allargano verso il bordo, in sorpasso guardano la posizione reale in pista e in un tornante
rallentano se sono all'interno. Prova degli incidenti: `devTools.incidenti(6)` nella console.

**Tempi indicativi dei bot "esperto"** con la monoposto: Monza ~1'30", con la GT
all'Anello di prova ~53–54 s in "medio".

### Fase 8 — rifinitura
- Impostazioni (menu principale e pausa): qualità grafica bassa/media/alta (ombre,
  risoluzione, densità alberi), contatore FPS, volume generale e motori avversari
- Rumore del motore dell'avversario più vicino, in base alla distanza
- Replay a fine sessione: play/pausa, ±10 s, velocità 0,25×–4×, barra del tempo,
  auto da seguire, camere TV a bordo pista con zoom o camere di bordo
- Corretto lo "sfarfallio" tra asfalto e prato visti da lontano

## Fase 7
- Menu ASSETTO (da scelta sessione o pausa), salvato per pista: ali, rapporto finale,
  differenziale, molle, barre, ammortizzatori, freni, pressioni, mescola, carburante
- Carburante per auto: consumo dalla potenza erogata (~0,76 kg/giro sull'Anello),
  peso che cala, motore che si spegne a secco (i bot a secco si ritirano)
- Corsia box con limitatore e pilota automatico: entri in corsia e la squadra ti porta
  alla piazzola; sosta = 4 s + max(cambio gomme 13 s, rifornimento 2,5 kg/s);
  "Strategia box" nel menu di pausa (gomme sì/no, mescola, kg da aggiungere)
- In prova/qualifica si esce dai box con il limitatore
- Strategia dei bot: benzina per la gara, sosta quando servono benzina o gomme
- Radio dal box: posizione e distacchi a ogni giro, avvisi gomme/benzina, soste avversari
- Moltiplicatori usura gomme e consumo nella scelta della sessione (Strategia)
- L'Anello di prova ora ha corsia box, muretto, tribuna e barriere

## Fase 6
- Scia aerodinamica: dietro un'altra auto meno resistenza (più velocità) e meno
  deportanza (meno aderenza in curva); HUD "In scia"
- Bot in corpo a corpo: sorpasso dal lato con più spazio (preferendo l'interno),
  in scia e in staccata, spazio all'auto affiancata, una sola mossa in difesa
- Errori dei bot: frenata lunga, bloccaggio senza ABS, troppo gas in uscita
  (più probabili ai livelli bassi, sotto pressione, in sorpasso, con gomme usurate)
- Bandiere gialla (auto ferma/fuori più avanti) e blu (doppiaggio): i bot rallentano
  o lasciano passare, l'HUD le mostra al pilota

## Fase 5
- Bot IA (fino a 19): traiettoria ideale calcolata in automatico su qualsiasi pista,
  profilo di velocità da aderenza/potenza/deportanza, stessi comandi e stessa fisica
  del pilota, 4 livelli (facile ~60 s, medio ~58, difficile ~56, esperto ~54,5 s
  sull'Anello di prova), variazione individuale, si accodano senza tamponare e
  aggirano le auto ferme (sorpassi e difese: Fase 6)
- Collisioni tra auto (rettangoli orientati, impulso con attrito)
- Griglia: ordine della qualifica, pole, metà o fondo
- Volante: calibrazione guidata (dispositivo, riposo, asse sterzo, gradi reali con il
  quarto di giro, pedali con riposo/fondo misurati, palette), sterzo reale 1:1 o scalato,
  linearità e zone morte; corretto il "mezzo gas" dei pedali mai mossi in Chrome
- Strumento sviluppatori: `devTools.bots(3, { opponents: 5, difficulty: 'esperto' })`

## Fase 4
- Sessioni: prove libere (con o senza limite di tempo), qualifica (a tempo, giro in corso
  completabile allo scadere), gara (a giri, partenza da fermo con semaforo, +5 s per
  partenza anticipata), risultati con classifica e giri, "Vai in gara" dopo la qualifica
- Cronometraggio: 3 settori colorati (viola record, verde migliore, giallo), delta in
  tempo reale, giri annullati (limiti, tagli, riposizionamento), giro ideale
- Record per pista+auto con fantasma (tasto F), elenco giri (tasto L)
- In prova/qualifica si parte dai box (se la pista li ha), in gara dalla griglia

## Fase 3
- Menu principale: elenco piste (incluse + tue), nuova, duplica, importa/esporta, elimina
- Editor 2D (`Modifica` dal menu): curve di Bézier con maniglie, larghezza per punto,
  cordoli per tratto, linea di partenza e griglia, 3 settori, corsia box con limitatore
  e box, oggetti di contorno (tribune, barriere, muri, gomme, alberi, edifici, cartelloni,
  tuoi GLB), immagine di sfondo da ricalcare con calibrazione della scala,
  annulla/ripeti, salvataggio automatico, avvisi (curve troppo strette, incroci),
  anteprima 3D, "Guida" per provarla subito
- Guida: si parte dalla pole position; la corsia box è percorribile;
  i record sono legati alla geometria (se modifichi la pista ripartono da zero)

## Fase 2
- Sospensioni vere (molle, ammortizzatori, barre antirollio): il trasferimento di carico
  passa dalla carrozzeria che beccheggia e rolla; cordoli rialzati, erba sconnessa
- Gomme: temperatura superficie/carcassa, pressione che sale col calore, usura,
  mescole morbida/media/dura, termocoperte opzionali, moltiplicatore usura
- Differenziale autobloccante a rampe (precarico, trazione, rilascio)
- HUD gomme (colore = temperatura, pressione, battistrada), telemetria T, grafici G
- Strumento di taratura per sviluppatori: in console `devTools.autopilot(5)`

## Fase 1
- Auto GT segnaposto su pista di prova (2,2 km), fisica a 240 Hz
- Fisica: 4 ruote con carico per ruota, trasferimento di carico, modello gomma
  con slip combinato, motore/cambio/differenziale autobloccante, aerodinamica,
  ABS e controllo trazione disattivabili
- Telecamere esterna, cofano, abitacolo · HUD · cronometro con giri non validi · record salvati
- Tastiera, gamepad, volante (mappatura regolabile) · audio motore sintetizzato
- Pannello di regolazione dal vivo (F2) e telemetria (T)

## Struttura
```
public/
  cars/       definizioni auto (*.car.json): tutti i numeri della fisica
  tracks/     piste (*.track.json)
  models/     modelli GLB + LEGGIMI.md (guida Blender)
src/
  core/       loop a passo fisso, matematica, salvataggi
  input/      tastiera, gamepad, volante
  physics/    Vehicle, Tire, Drivetrain, Aero, CarParams
  track/      formato pista, spline (coordinate s,d), generatore 3D
  render/     scena, caricamento modelli, vista auto, telecamere, texture
  race/       cronometraggio, sessioni, fantasma, replay
  ai/         traiettoria ideale, pilota bot, elenco piloti
  strategy/   assetto, menu assetto, pilota automatico ai box
  editor/     editor piste 2D, anteprima 3D
  storage/    IndexedDB: piste, sfondi, record
  ui/         HUD, schermate, pannello debug
  audio/      suono motore
  game/       Game.ts: collega tutto
```

## Dove mettere le mani
- **Comportamento dell'auto**: `public/cars/gt_segnaposto.car.json` (oppure F2 in gioco, poi "Esporta auto").
- **Monoposto**: `public/cars/monoposto_2026.car.json` (aerodinamica attiva, ERS, effetto suolo, box);
  fisica ibrida in `src/physics/Hybrid.ts`, modello segnaposto in `src/render/PlaceholderF1.ts`.
- **Elenco auto**: `public/cars/index.json`.
- **Pista**: `public/tracks/anello_prova.track.json` (punti x/z in metri; dalla Fase 3 ci sarà l'editor).
- **Il tuo modello 3D**: vedi `public/models/LEGGIMI.md`.
