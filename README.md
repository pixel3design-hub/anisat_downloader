<p align="center">
  <img src="docs/icon.png" width="128" alt="Icona di AniSat Downloader">
</p>

<h1 align="center">AniSat Downloader</h1>

<p align="center">
  Estensione per Brave, Chrome, Chromium, Edge e Firefox, più un piccolo servizio Rust che tiene
  aggiornato un feed RSS delle serie che segui su
  <a href="https://www.animesaturn.net">animesaturn.net</a>.
</p>

## A cosa serve

AnimeSaturn pubblica le puntate una alla volta, non ha una coda di download e non dice quando esce la
prossima. Se segui quattro o cinque serie, finisci per aprire il sito ogni giorno, controllare cosa è
uscito, aprire il player e salvare i file a mano.

L'estensione fa quel lavoro:

- tiene l'elenco delle serie che segui, con le puntate uscite e quelle previste;
- scarica gli episodi che scegli nella cartella che indichi una volta sola (o in `Download/` se non ne
  scegli una), e sa anche produrre un file di testo con gli URL diretti per chi preferisce aria2 o
  JDownloader;
- scrive un feed RSS con le uscite e la stima della prossima puntata, così un lettore RSS ti avvisa
  senza tenere il browser aperto.

Quello che non fa: non tocca la tua cronologia o il tuo profilo sul sito, non converte i video (il
sito serve già mp4 progressivi, niente HLS) e non nasconde che il download da un sito di terze parti
resti un uso personale da valutare rispetto ai loro termini.

## Cosa c'è nel repository

| Cartella | Contenuto |
|---|---|
| `extension/` | l'estensione MV3 in JS puro, senza bundler |
| `service/` | `anisat-feed`, il servizio Rust che salva e serve il feed |
| `packaging/` | nfpm, PKGBUILD, Flatpak, AppImage, icone |
| `tools/build.mjs` | costruisce i pacchetti per i browser |
| `docs/PUBLISHING.md` | come caricare l'estensione sugli store |

## Browser supportati

Un solo codice sorgente, con lo shim `extension/lib/api.js` che usa `browser.*` su Firefox e
`chrome.*` sugli altri. `node tools/build.mjs` produce cartelle e zip separati:

| Browser | Pacchetto | Differenza |
|---|---|---|
| Brave, Chrome, Chromium, Vivaldi, Edge, Opera | `dist/chrome/` · `anisat-extension-chrome-<ver>.zip` · `anisat-extension-brave-<ver>.zip` | MV3 con service worker |
| Firefox 142+ | `dist/firefox/` · `anisat-extension-firefox-<ver>.zip` | MV3 con event page, id gecko, permesso DNR classico |

Il pacchetto Brave è lo stesso file del pacchetto Chrome, con il nome che Brave si aspetta quando lo
trascini in `brave://extensions`. Gli zip sono allegati a ogni release; per la pubblicazione sugli
store vedi [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Installazione

### Estensione

1. Brave: apri `brave://extensions`, attiva *Modalità sviluppatore*, premi *Carica estensione non
   pacchettizzata* e scegli `dist/chrome/` (su Chrome è `chrome://extensions`, su Edge
   `edge://extensions`). Su Firefox: `about:debugging#/runtime/this-firefox` → *Carica componente
   temporaneo* → `dist/firefox/manifest.json`.
2. Apri il popup e usa **Cerca**: scrivi il nome della serie, premi `+`, e se il sito ha più stagioni
   scegli quale aggiungere o prendile tutte.
3. Dalle opzioni (⚙ nel popup) imposti download in parallelo, intervallo di aggiornamento, indirizzo
   del servizio feed e la **cartella dei download**: la scegli una volta con il selettore di sistema e
   da lì i file vengono scritti direttamente, senza il dialogo "salva con nome" a ogni episodio.

### Cartella dei download

I download li fa il servizio, non il browser. La cartella si imposta una volta nella pagina di
configurazione (campo *Cartella dei download*, default `~/Downloads/AniSatDownloader`) e da lì gli
episodi vengono scritti direttamente, con la percentuale che avanza nella scheda Coda.

Perché non lo fa il browser: se in Brave è attiva l'opzione *chiedi dove salvare ogni file*,
`chrome.downloads` apre il dialogo a ogni episodio, e la File System Access API non risolve perché un
handle ripreso da IndexedDB torna con permesso `prompt` fuori dalla pagina che l'ha scelto. Con il
servizio attivo non compare nessun dialogo. Se il servizio non è in esecuzione l'estensione torna a
`chrome.downloads` sulla cartella predefinita del browser, e lì vale l'opzione di Brave.

### Servizio feed

```bash
cd service
cargo build --release
./target/release/anisat-feed              # icona nella barra + server
./target/release/anisat-feed --headless   # senza tray, per systemd o macchine senza sessione grafica
```

Il servizio salva in `~/.anisatrss/feed.rss` e risponde su `http://127.0.0.1:8787/`:

- `GET /` è la pagina di configurazione: nome del feed, indirizzo di ascolto, ogni quanti minuti
  ricontrollare file e versione, controllo aggiornamenti su GitHub con avviso.
- `GET /feed.xml` (o `/feed.rss`) è il feed da dare al lettore RSS.
- `GET /status`, `GET /health` per diagnostica; `POST /feed` riceve il feed dall'estensione.
- Il nome impostato nella pagina sostituisce il titolo del canale; cambiare indirizzo fa ripartire
  l'ascolto senza riavviare il programma.

L'icona nella barra usa StatusNotifierItem via D-Bus (`ksni`), quindi non tira dentro GTK. Su Windows
e macOS il tray per ora non c'è: il binario resta a console e la configurazione si apre dal browser
sull'indirizzo sopra.

I binari precompilati sono nelle [release](https://github.com/pixel3design-hub/anisat_downloader/releases):
Linux `x86_64`/`aarch64` come `.tar.gz`, `.deb` e `.rpm`, Windows come `.zip`. macOS dipende dalla
disponibilità dei runner GitHub e viene caricato a parte. AppImage e Flatpak si generano a mano dal
workflow *packaging extra*.

Su Fedora, installazione, aggiornamenti e repository locale sono descritti in
[docs/FEDORA.md](docs/FEDORA.md) (`packaging/setup-local-repo.sh` crea il repo per `dnf search` e
`dnf upgrade`).

I pacchetti `.deb` e `.rpm` installano anche `.desktop`, metainfo AppStream e l'icona in
`hicolor/256x256`, quindi dopo l'installazione `anisat-feed` compare con la sua icona nel menu
applicazioni e nella pagina "Installati" del software center.

## Come funziona lo scraping

Verificato sul sito il 19 novembre 2026:

| Passo | Endpoint |
|---|---|
| ricerca per nome | `GET /api/search?q=<nome>` → JSON |
| pagina serie | `/anime/<slug>` → JSON-LD `TVSeries` (`numberOfEpisodes`) e griglia `a.ep-tile` |
| previsti e usciti | riquadro meta `Episodi` = previsti, titolo `Episodi (N)` = usciti |
| pagina episodio | `/anime/<slug>/ep-N` → `watchPage({...})` con `episodeId` e `servers[].link` |
| manifest | `GET https://play.saturncdn.net/embed/<id>/playlist?token=<k>&expires=<e>` con `Referer: https://play.saturncdn.net/` |
| file | base64 più XOR con la chiave `<k>` → URL `.mp4` diretto |

Due dettagli che contano se ci metti mano:

- la pagina con il player è `/anime/<slug>/ep-N`. `/episode/<slug>/ep-N` è una scheda senza video, e
  il sito la linka dappertutto: è la trappola principale dell'adapter.
- `Referer` non si può impostare da `fetch()`. Lo aggiunge la regola `declarativeNetRequest` in
  `extension/rules/stream.json`, che funziona sia in Chrome sia in Firefox (provato su Firefox 160
  con `web-ext`).

Il token dell'URL scade dopo circa 12 ore, quindi le liste esportate vanno rigenerate; la coda
ri-risolve l'URL quando parte il download.

### Stagioni

Il sito non etichetta le relazioni: `/related/<slug>` mescola prequel, sequel, versioni ITA, film e
spin-off. L'estensione ricava la stagione dal titolo (`... 2`, `... Season 2`, `... 2nd Season`) e
raggruppa per titolo normalizzato più lingua. Numeri sopra 20 restano nel titolo, se no "Mob Psycho
100" diventerebbe la stagione 100. Ogni stagione aggiunta resta una serie separata con i suoi episodi.

### Contenuto del feed

Il feed contiene tutte le puntate di tutte le stagioni aggiunte, non solo le ultime. Se una stagione
è in corso, la puntata successiva compare come `Ep N (in arrivo)` con `<category>in-arrivo</category>`
e senza link al video: nel popup la casella e i pulsanti di quella riga sono disattivati.

### Tempo mancante alla prossima puntata

Il sito non pubblica la data della puntata successiva, e `/rss/anime?slug=` ignora lo slug
restituendo il feed globale. La stima, etichettata `(stimato)`, usa la mediana degli intervalli
osservati tra le uscite con fallback a sette giorni; le date delle serie non ancora iniziate arrivano
da `/upcoming`.

## Sviluppo

```bash
node --test extension/tests/parse.test.mjs      # parsing, decodifica, stagioni, feed
cargo test --manifest-path service/Cargo.toml   # configurazione, rotte HTTP, rebind
node tools/build.mjs                            # pacchetti per i browser
npx web-ext lint --source-dir dist/firefox      # validazione per AMO (0 errori)
```

## Licenza

GPL-2.0, vedi [COPYING](COPYING).

## Riferimenti

- Autore: Cristiano Gariboldo, <social@pixel3design.it>
- Repository: <https://github.com/pixel3design-hub/anisat_downloader>
- Segnalazioni: <https://github.com/pixel3design-hub/anisat_downloader/issues>
- Release con binari ed estensione: <https://github.com/pixel3design-hub/anisat_downloader/releases>
- Icona: `icon.png` (1024×1024) è il sorgente; `packaging/make-icons.sh` rigenera
  `extension/icons/*.png`, `packaging/icon.png`, `service/assets/icon.png` e `docs/icon.png`
