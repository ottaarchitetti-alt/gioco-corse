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

## Stato: Fase 2 completata
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
