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

## Stato: Fase 6 completata
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
  race/       cronometraggio
  ui/         HUD, schermate, pannello debug
  audio/      suono motore
  game/       Game.ts: collega tutto
```

## Dove mettere le mani
- **Comportamento dell'auto**: `public/cars/gt_segnaposto.car.json` (oppure F2 in gioco, poi "Esporta auto").
- **Pista**: `public/tracks/anello_prova.track.json` (punti x/z in metri; dalla Fase 3 ci sarà l'editor).
- **Il tuo modello 3D**: vedi `public/models/LEGGIMI.md`.
