# anisat_downloader

Estensione per Brave (Chromium MV3) + servizio Rust per gestire serie, download e uscite di
[animesaturn.net](https://www.animesaturn.net).

- **Estensione** = cervello: cerca le serie per nome, propone le stagioni trovate dai "Correlati",
  elenca gli episodi scaricabili, gestisce la coda di download nativa di Brave, esporta la lista di
  file per aria2/JDownloader, tiene i preferiti e lo stato di visione, genera il feed RSS.
- **Servizio Rust** (`anisat-feed`): riceve il feed dall'estensione (`POST /feed`), lo salva in
  `~/.anisatrss/feed.rss` e lo serve su `http://127.0.0.1:8787/feed.xml`. Così un lettore RSS ha una
  URL stabile e il feed resta raggiungibile anche a browser chiuso. Se il servizio non risponde
  l'estensione non salva niente: chiede se riprovare o scaricare `feed.rss`.

## Browser supportati

Un solo codice sorgente in `extension/`, con lo shim `lib/api.js` che usa `browser.*` su Firefox
e `chrome.*` altrove. I pacchetti si costruiscono con `node tools/build.mjs`:

| Browser | Pacchetto | Note |
|---|---|---|
| Chrome, Chromium, Brave, Vivaldi, Edge, Opera | `dist/chrome/` · `anisat-extension-chrome-<ver>.zip` | MV3 con service worker |
| Firefox 142+ | `dist/firefox/` · `anisat-extension-firefox-<ver>.zip` | MV3 con event page, id gecko, permesso DNR classico |

Gli zip sono allegati a ogni release. Pubblicazione sugli store: [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Installazione

### Estensione

1. `brave://extensions` (o `chrome://extensions`, `edge://extensions`) → *Modalità sviluppatore* →
   *Carica estensione non pacchettizzata* → seleziona `dist/chrome/` (oppure `extension/`).
   Su Firefox: `about:debugging#/runtime/this-firefox` → *Carica componente temporaneo* →
   `dist/firefox/manifest.json`.
2. Apri il popup: **Cerca** → nome della serie → `+` (oppure incolla l'URL della serie).
3. Scegli opzioni (⚙ dal menu estensioni): download in parallelo, intervallo di aggiornamento,
   cartella dei download, server del feed.

### Servizio feed

```bash
cd service
cargo build --release
./target/release/anisat-feed        # tray + server, salva in ~/.anisatrss/feed.rss
./target/release/anisat-feed --headless   # senza tray (systemd, server senza sessione grafica)
```

- **Pagina di configurazione**: `http://127.0.0.1:8787/` (si apre anche dal menu dell'icona nella
  barra dei programmi): nome del feed, indirizzo di ascolto, ogni quanti minuti ricontrollare file e
  versione, controllo aggiornamenti su GitHub con avviso.
- **Icona nella barra**: StatusNotifierItem via D-Bus (`ksni`, nessuna dipendenza GTK). Su Windows e
  macOS per ora non c'è tray: il binario resta a console e la configurazione si apre dal browser.
- **Rotte**: `GET /` configurazione · `POST /config` · `POST /feed` · `GET /feed.xml` · `GET /status`
  · `GET /health`. Cambiare indirizzo dalla pagina riavvia l'ascolto da solo.
- Il nome impostato sostituisce il `<title>` del canale nel feed ricevuto dall'estensione.

Binari precompilati: vedi [Releases](https://github.com/pixel3design-hub/anisat_downloader/releases) —
`x86_64` e `aarch64` per Linux (`.tar.gz`, `.deb`, `.rpm`) e Windows (`.zip`); macOS `x86_64`/`aarch64`
dipende dalla disponibilità dei runner GitHub e viene caricato a parte. AppImage e Flatpak si
generano dal workflow manuale *packaging extra*.

I pacchetti `.deb`/`.rpm` installano anche `.desktop`, metainfo AppStream e icona in
`hicolor/256x256`: dopo l'installazione `anisat-feed` compare con la sua icona nel menu applicazioni
e nella pagina "Installati" del software center (KDE Discover, GNOME Software).

## Come funziona lo scraping (verificato sul sito)

| Passo | Endpoint |
|---|---|
| ricerca per nome | `GET /api/search?q=<nome>` → JSON |
| pagina serie | `/anime/<slug>` → JSON-LD `TVSeries` (`numberOfEpisodes`) + griglia `a.ep-tile` |
| previsti / usciti | riquadro meta `Episodi` = previsti · titolo `Episodi (N)` = usciti |
| pagina episodio | `/anime/<slug>/ep-N` o `/episode/<slug>/ep-N` → `watchPage({...})` con `episodeId` e `servers[].link` |
| manifest | `GET https://play.saturncdn.net/embed/<id>/playlist?token=<k>&expires=<e>` **con `Referer: https://play.saturncdn.net/`** |
| file | base64 + XOR con la chiave `<k>` → URL `.mp4` diretto |

Il video è un **mp4 progressivo** (niente HLS): il download non richiede `ffmpeg` né `yt-dlp`.
`Referer` non è impostabile da `fetch()`: lo aggiunge la regola `declarativeNetRequest` in
`extension/rules/stream.json`. Il token dell'URL scade dopo ~12 ore, quindi le liste esportate vanno
rigenerate (la coda ri-risolve l'URL al momento del download).

### Stagioni

Il sito non etichetta le relazioni: i "Correlati" (`/related/<slug>`) mescolano prequel, sequel,
versioni ITA, film e spin-off. Le stagioni si ricavano dal titolo (`... 2`, `... Season 2`, `(ITA)`)
e si raggruppano per titolo normalizzato + lingua. All'aggiunta l'estensione mostra le stagioni
trovate: si può sceglierne una o prenderle tutte, e ogni stagione resta una serie separata con i
suoi episodi.

### Contenuto del feed

- tutte le puntate di tutte le stagioni aggiunte (non solo le ultime);
- se una stagione è in corso, la puntata successiva compare come `Ep N (in arrivo)` con
  `<category>in-arrivo</category>`, senza link al video: è la riga "disabilitata", e nel popup la
  casella e i pulsanti di quella puntata sono disattivati.

### Tempo mancante alla prossima puntata

Il sito non pubblica la data della puntata successiva, e `/rss/anime?slug=` ignora lo slug. La stima
(etichettata `(stimato)` nel feed) usa la mediana degli intervalli osservati tra le uscite, con
fallback settimanale; le date delle serie non ancora iniziate arrivano da `/upcoming`.

## Sviluppo

```bash
node --test extension/tests/parse.test.mjs   # parsing + decodifica su fixture reali
cargo test --manifest-path service/Cargo.toml
```

Layout: `extension/` (MV3, JS puro, nessun bundler), `service/` (Rust, una dipendenza: `tiny_http`),
`packaging/` (nfpm, PKGBUILD, Flatpak, AppImage), `.github/workflows/` (release + packaging extra).

## Licenza

GPL-2.0 — vedi [COPYING](COPYING).

Il progetto è uno strumento personale: il sito di riferimento è di terze parti e i suoi termini
possono vietarne il download.

## Riferimenti

- Autore: Cristiano Gariboldo — <social@pixel3design.it>
- Repository: <https://github.com/pixel3design-hub/anisat_downloader>
- Segnalazioni: <https://github.com/pixel3design-hub/anisat_downloader/issues>
- Release (binari `anisat-feed`): <https://github.com/pixel3design-hub/anisat_downloader/releases>
- Icona: `icon.png` (sorgente 1024×1024) → `packaging/make-icons.sh` rigenera
  `extension/icons/*.png` e `packaging/icon.png`
