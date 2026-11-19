# anisat_downloader

Estensione per Brave (Chromium MV3) + servizio Rust per gestire serie, download e uscite di
[animesaturn.net](https://www.animesaturn.net).

- **Estensione** = cervello: cerca serie per nome, elenca gli episodi scaricabili, coda di download
  nativa di Brave, esporta la lista di file (`list.txt`) per aria2/JDownloader, gestisce preferiti e
  visione, genera il feed RSS.
- **Servizio Rust** (`anisat-feed`) = server statico del feed: espone `feed.xml` su
  `http://127.0.0.1:8787/feed.xml`, così un lettore RSS ha una URL stabile e i download continuano a
  funzionare a browser chiuso.

## Come funziona lo scraping (verificato sul sito)

| Passo | Endpoint |
|---|---|
| ricerca per nome | `GET /api/search?q=<nome>` → JSON |
| pagina serie | `/anime/<slug>` → JSON-LD `TVSeries` (`numberOfEpisodes`) + griglia `a.ep-tile` |
| previsti / usciti | riquadro meta `Episodi` = previsti · titolo `Episodi (N)` = usciti |
| pagina episodio | `/anime/<slug>/ep-N` o `/episode/<slug>/ep-N` → `watchPage({...})` con `episodeId` e `servers[].link` |
| manifest | `GET https://play.saturncdn.net/embed/<id>/playlist?token=<k>&expires=<e>` con `Referer: https://play.saturncdn.net/` |
| file | base64 + XOR con la chiave `<k>` → URL `.mp4` diretto |

Il video è un **mp4 progressivo** (niente HLS): il download non richiede `ffmpeg` né `yt-dlp`.
Il token dell'URL scade dopo ~12 ore, quindi le liste esportate vanno rigenerate.

## Licenza

GPL-2.0 — vedi [COPYING](COPYING).

Il progetto è uno strumento personale: il sito di riferimento è di terze parti e i suoi termini
possono vietarne il download.
