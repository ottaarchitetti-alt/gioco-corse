# Guida: preparare i modelli in Blender

Il gioco carica il file indicato nel campo `"model"` del file auto
(es. `public/cars/gt_segnaposto.car.json` → `"model": "models/gt_car.glb"`).
Se il file non c'è, usa automaticamente il segnaposto: quindi **basta salvare
il tuo GLB qui con quel nome** (o cambiare il nome nel JSON) e ricaricare la pagina.

## 1. Impostazioni della scena
- *Scene Properties → Units*: **Metric**, *Unit Scale* **1.0**, lunghezza in metri.
- Modella in scala reale: una GT è lunga circa 4,5–4,7 m, larga circa 2 m.

## 2. Orientamento e origine
- **Muso verso −Y** di Blender: premendo `1` sul tastierino (vista frontale) devi vedere il muso.
- **Alto = +Z**, l'auto appoggia sul piano Z = 0 (le gomme toccano Z = 0).
- **Origine della carrozzeria**: a terra (Z = 0), centrata in larghezza (X = 0),
  **a metà strada tra asse anteriore e posteriore** (Y = 0).
  Suggerimento: metti il 3D cursor in (0,0,0) e usa *Object → Set Origin → Origin to 3D Cursor*.

## 3. Ruote
Quattro **oggetti separati**, con questi nomi esatti:

| Nome | Posizione |
|---|---|
| `wheel_FL` | anteriore sinistra (lato +X in Blender) |
| `wheel_FR` | anteriore destra (lato −X) |
| `wheel_RL` | posteriore sinistra |
| `wheel_RR` | posteriore destra |

- **Origine di ogni ruota al centro del mozzo** (*Set Origin → Origin to Geometry* di solito va bene).
- L'asse di rotazione della ruota deve essere l'**asse X**.
- Ogni ruota può contenere figli (cerchio, pneumatico, bulloni): ruotano insieme.
- Dischi e pinze freno, se li vuoi fermi, **non** vanno dentro la ruota.
- Con `"geometryFromModel": true` nel file auto, **passo, carreggiate e raggio
  vengono letti dalle posizioni delle tue ruote**: la fisica si adatta al modello.

## 4. Oggetti opzionali riconosciuti
| Nome | Cosa fa |
|---|---|
| `steering_wheel` | il volante: ruota con lo sterzo (origine al centro del volante) |
| `cam_cockpit` | Empty: posizione degli occhi del pilota (camera abitacolo) |
| `cam_hood` | Empty: posizione della camera cofano |

Gli Empty delle camere vanno lasciati **senza rotazione**: la camera guarda verso il muso.
La guida è a sinistra (+X), ma puoi mettere `cam_cockpit` dove vuoi.

## 5. Materiali
- Usa il **Principled BSDF** (diventa un materiale PBR glTF).
- Il materiale chiamato **`paint`** (anche `paint.001` ecc.) viene ricolorato dal
  gioco: così i bot avranno livree diverse con lo stesso modello.
- Facoltativi: il materiale **`accent`** (strisce, dettagli) riceve in automatico un
  colore a contrasto (scuro sulle auto chiare, bianco sulle scure); il materiale
  **`number`** riceve una texture con il numero di gara (un tondo bianco con il
  numero nero): mettilo su un piano con UV da 0 a 1, ad esempio sulle portiere.
- Texture: al massimo 2048×2048, meglio se in formato PNG/JPG.

## 6. Prima di esportare
1. Seleziona tutto → `Ctrl+A` → **All Transforms** (applica posizione/rotazione/scala).
   *Attenzione*: dopo averlo fatto, rimetti l'origine delle ruote al centro del mozzo.
2. Controlla le normali (*Overlays → Face Orientation*: tutto blu).
3. Budget indicativo: 30–80 mila triangoli per auto.

## 7. Esportazione
*File → Export → glTF 2.0 (.glb/.gltf)*
- **Format**: glTF Binary (.glb)
- **Include**: *Selected Objects* (se vuoi esportare solo l'auto), *Custom Properties* opzionale
- **Transform**: **+Y Up** ✔ (il gioco si aspetta questo)
- **Data → Mesh**: *Apply Modifiers* ✔, UVs ✔, Normals ✔
- **Data → Material**: Export
- **Animation**: non serve (disattivala)

Salva come `public/models/gt_car.glb` e ricarica il browser. Nella console del browser
(F12) vedrai `Modello caricato` e la geometria letta dalle ruote.

## 8. Elementi della pista
La pista (asfalto, cordoli, prato) è **generata dal gioco** a partire dal disegno
dell'editor. In Blender modellerai solo gli elementi di contorno (tribune, barriere,
box, cartelloni):
- origine a terra, al centro dell'oggetto; unità in metri;
- la **lunghezza** dell'oggetto lungo l'asse **X** di Blender;
- il lato **frontale** (es. dove guardano le tribune) verso **−Y** di Blender
  (come il muso delle auto); export GLB con "+Y Up".

Salva i file in `public/models/props/`. Nell'editor: strumento **Oggetti** → tipo
"Modello GLB" → scrivi il percorso (es. `models/props/tribuna.glb`). Il campo
"Lunghezza" scala il modello in modo che la sua dimensione lungo X sia quella indicata.
