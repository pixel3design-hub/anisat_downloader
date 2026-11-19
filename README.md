# anisat_downloader

Estensione per Brave (Chromium MV3) + servizio Rust per gestire serie, download e uscite di
[animesaturn.net](https://www.animesaturn.net).

- **Estensione** = cervello: cerca le serie per nome, elenca gli episodi scaricabili, gestisce la
  coda di download nativa di Brave, esporta la lista di file per aria2/JDownloader, tiene i preferiti
  e lo stato di visione, genera `feed.xml`.
- **Servizio Rust** (`anisat-feed`) = server statico del feed: espone `feed.xml` su
  `http://127.0.0.1:8787/feed.xml`, così un lettore RSS ha una URL stabile e il feed resta
  raggiungibile anche a browser chiuso.

## Installazione

### Estensione

1. `brave://extensions` → attiva *Modalità sviluppatore* → *Carica estensione non pacchettizzata* →
   seleziona `extension/`.
2. Apri il popup: **Cerca** → nome della serie → `+` (oppure incolla l'URL della serie).
3. Scegli opzioni (⚙ dal menu estensioni): download in parallelo, intervallo di aggiornamento,
   sottocartella del feed.

### Servizio feed

```bash
cd service
cargo build --release
./target/release/anisat-feed --feed ~/Downloads/AniSatDownloader/feed.xml
# http://127.0.0.1:8787/feed.xml
```

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
