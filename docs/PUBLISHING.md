# Pubblicare l'estensione sugli store

L'estensione è un singolo codice sorgente (`extension/`) che parla l'API `browser`/`chrome`
tramite lo shim `extension/lib/api.js`. I pacchetti si generano con:

```bash
node tools/build.mjs
# dist/chrome/                                 → Chrome, Chromium, Edge, Brave, Opera
# dist/anisat-extension-chrome-<ver>.zip
# dist/firefox/                                → Firefox (event page + gecko id)
# dist/anisat-extension-firefox-<ver>.zip
```

Gli stessi zip vengono prodotti automaticamente a ogni release GitHub (job `extension`):
si scaricano dagli asset della release, senza ricostruire nulla.

## Prima di tutto: il rischio di policy

L'estensione scarica video da `animesaturn.net`, un sito di streaming di terze parti. Il Chrome Web
Store vieta le estensioni che «facilitano la violazione del copyright» e la stessa regola vale su
Edge e, in forma simile, su AMO. **È realistico che una revisione manuale rifiuti o rimuova
l'estensione.** Conseguenze pratiche:

- Chrome/Edge: pubblicare come **unlisted/privato** riduce l'esposizione ma non elimina il rischio di
  rimozione; il pagamento dei 5 $ non è rimborsabile.
- Firefox AMO: si può scegliere la **distribuzione autonoma** (`On your own`): Mozilla firma l'XPI
  automaticamente e non lo elenca nel catalogo. Niente vetrina, ma installabile con un file e
  aggiornabile via `update_url`.
- In alternativa gli zip restano installabili a mano: Chrome/Chromium/Edge/Brave in modalità
  sviluppatore, Firefox tramite `about:debugging` o `web-ext run`.

## Chrome Web Store (Chrome, Chromium, Brave, Vivaldi)

1. Registra un account sviluppatore su <https://chrome.google.com/webstore/devconsole>: **5 $ una
   volta sola**, non rimborsabili. Serve la verifica dell'email e, per i publisher UE, la
   dichiarazione di status «trader/non-trader» (DSA).
2. Crea una nuova voce, carica `anisat-extension-chrome-<ver>.zip`. All'upload parte un **test di
   installazione automatico** che segnala subito pacchetti invalidi.
3. Compila la scheda: nome, descrizione breve e lunga, categoria, lingua, icona 128×128 (già nel
   pacchetto), almeno **1 screenshot** (1280×800 o 640×400), URL del repo, informativa privacy.
4. **Privacy practices** (obbligatorio): scopo unico, motivazione di ogni permesso, dichiarazione su
   dati raccolti. Qui i permessi vanno giustificati uno per uno: `downloads` (salvare gli episodi),
   `storage` (preferiti), `alarms` (controllo uscite), `declarativeNetRequestWithHostAccess`
   (header `Referer` richiesto dal player), host `animesaturn.net` / `play.saturncdn.net` /
   `127.0.0.1` (il feed locale).
5. Invia per la revisione. I tempi sono tornati a qualche giorno; le nuove pubblicazioni partono
   comunque da un limite di **2 slot per publisher** (aggiornamento di agosto 2026), aumentabile
   dalla dashboard.
6. Aggiornamenti: stesso zip con `version` incrementata nel manifest, poi «Publish».

Nota: Brave, Chromium, Vivaldi e Opera (versione desktop) possono installare direttamente dal Chrome
Web Store, quindi un solo pacchetto copre quei browser. Opera ha anche un suo store, facoltativo.

## Microsoft Edge Add-ons

1. Account <https://partner.microsoft.com> (gratuito) → programma *Edge Add-ons*.
2. Carica lo **stesso** `anisat-extension-chrome-<ver>.zip` (Edge è Chromium: il pacchetto Chrome va
   bene, non serve rigenerarlo).
3. Scheda + privacy; revisione tipicamente 1–7 giorni. Esiste la possibilità di importare
   automaticamente l'estensione dal Chrome Web Store se è già pubblicata lì.

## Firefox (addons.mozilla.org)

Serve il pacchetto Firefox: `anisat-extension-firefox-<ver>.zip`, che differisce dal Chrome per
`background` (`scripts` + `type: module` invece di `service_worker`), per il permesso
`declarativeNetRequest` (al posto di `declarativeNetRequestWithHostAccess`) e per l'id gecko
`anisat-downloader@pixel3design.it`.

1. Account Mozilla su <https://addons.mozilla.org> (gratuito) → *Submit a New Add-on*.
2. Scegli **On this site** (catalogo AMO) oppure **On your own** (distribuzione autonoma firmata).
3. Carica lo zip: il validatore gira subito. In questo progetto restano solo warning
   `UNSAFE_VAR_ASSIGNMENT` (innerHTML già sanificato) — accettabili, ma vanno letti.
4. Compila la scheda: riassunto, descrizione, categoria, licenza (GPL-2.0 è nell'elenco), email di
   supporto, **privacy policy** (obbligatoria: l'estensione contatta animesaturn.net e il server
   locale), note per il revisore.
5. Se pubblichi sul catalogo, la revisione può richiedere giorni. Se scegli la distribuzione
   autonoma ottieni un `.xpi` firmato: chi lo installa riceve gli aggiornamenti solo se nel manifest
   c'è `browser_specific_settings.gecko.update_url`.
6. Automazione: `npx web-ext sign --api-key=… --api-secret=… --source-dir dist/firefox` firma e
   carica da riga di comando (le credenziali si generano su AMO → API keys).

Verifiche locali prima di inviare:

```bash
node tools/build.mjs
npx web-ext lint --source-dir dist/firefox     # 0 errori richiesti
npx web-ext run  --source-dir dist/firefox     # prova con un profilo temporaneo
```

## Checklist comune

- [ ] `version` nel manifest incrementata (la versione del pacchetto = tag della release)
- [ ] `node --test extension/tests/parse.test.mjs` verde
- [ ] `npx web-ext lint --source-dir dist/firefox` senza errori
- [ ] screenshot aggiornati a ogni cambio di UI
- [ ] URL del repo, supporto e privacy policy nella scheda
- [ ] conservare gli zip della release: sono l'artefatto che gli store si aspettano
