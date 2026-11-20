# Fedora: installare, cercare e aggiornare

## Perché `dnf search anisat*` non trova niente

`dnf` cerca nei repository configurati in `/etc/yum.repos.d`. I pacchetti di questo progetto non sono
in nessun repository: sono `.rpm` scaricati a mano, quindi prima dell'installazione non esistono per
dnf. Dopo l'installazione invece dnf li vede:

```bash
dnf search 'anisat*'          # trova anisat-feed.x86_64 (0.6.0-1, @commandline)
dnf info anisat-feed
dnf list installed 'anisat*'
rpm -qa 'anisat*'
```

Se vuoi che `dnf search` lo trovi anche prima di installare, e che `dnf upgrade` faccia gli
aggiornamenti, serve un repository: vedi la sezione "Repository locale" più sotto.

## Installare un aggiornamento

```bash
sudo dnf install ./anisat-feed-0.6.0-1.x86_64.rpm
```

Sostituisce la versione precedente. Verificato con `dnf install --assumeno` su un sistema con la 0.6.0
installata e il pacchetto 0.5.0 indicato:

```
Retrocessione:
 anisat-feed  x86_64  0:0.5.0-1  @commandline  3.8 MiB
   sostituisce anisat-feed x86_64 0:0.6.0-1 @commandline  3.9 MiB
```

## Se restano due versioni installate

`dnf install` non duplica. `rpm -i` sì: `-i` sta per *install* e non rimuove la versione precedente,
quindi si ritrovano due pacchetti con lo stesso nome e versioni diverse.

```bash
rpm -qa 'anisat*'                    # elenca i pacchetti installati: dovrebbe essere una riga
sudo dnf remove anisat-feed-0.5.0-1  # rimuove la versione vecchia rimasta
```

Un caso diverso: KDE Discover, nella scheda di un file `.rpm` scaricato, mostra il pacchetto e accanto
l'app già installata. Sono la stessa cosa vista due volte; conta solo quello che stampa `rpm -qa`.

## Repository locale

`packaging/setup-local-repo.sh` crea la repodata dai pacchetti scaricati e prepara il file `.repo`:

```bash
# scarica l'ultima release e crea il repository
./packaging/setup-local-repo.sh --fetch

# oppure usa gli rpm che hai già in una cartella
./packaging/setup-local-repo.sh ~/Downloads

# attiva il repository (unico passaggio con sudo)
sudo install -m644 /tmp/anisat.repo /etc/yum.repos.d/anisat.repo
```

Da quel momento valgono i comandi normali, e ogni aggiornamento sostituisce la versione precedente:

```bash
dnf search anisat
dnf install anisat-feed
dnf upgrade anisat-feed
```

Il repository punta a una cartella locale (`baseurl=file://...`), quindi gli aggiornamenti si vedono
solo dopo che i nuovi `.rpm` sono in quella cartella: rilancia `setup-local-repo.sh --fetch` quando
esce una release. Lo script usa `createrepo_c`; se manca, prova con un container podman.

## COPR (repository vero, con `dnf search` e aggiornamenti)

COPR è il servizio Fedora per repository personali: una volta pubblicato lì, i pacchetti si installano
e si aggiornano come qualsiasi altro pacchetto Fedora.

`packaging/copr/anisat-feed.spec` impacchetta i binari della release (x86_64 e aarch64) invece di
ricompilare: le dipendenze Rust in `cargo vendor` occupano 176 MB, di cui 91 MB di crate Windows
richiesti comunque dal lock, e i build COPR girano senza rete.

### Pubblicare

```bash
# 1. costruisce l'SRPM scaricando i tarball della release (usa rpmbuild o un container podman)
./packaging/copr/make-srpm.sh v0.6.0

# 2. una volta solo: crea il progetto su COPR (account su copr.fedorainfracloud.org)
copr-cli create anisat-feed \
  --chroots fedora-43-x86_64 fedora-43-aarch64 fedora-42-x86_64 fedora-42-aarch64 fedora-rawhide-x86_64

# 3. carica il build
copr-cli build anisat-feed dist/copr/SRPMS/anisat-feed-0.6.0-1.fc44.src.rpm
```

L'API key per `copr-cli` si prende da <https://copr.fedorainfracloud.org/api/> e si salva in
`~/.config/copr`. In alternativa si carica l'SRPM a mano dall'interfaccia web (*New Build*), senza
installare nulla.

### Per gli utenti

```bash
sudo dnf copr enable <tuo-utente>/anisat-feed
sudo dnf install anisat-feed
sudo dnf upgrade anisat-feed     # gli aggiornamenti arrivano con ricaricare il progetto su COPR
```

### Verifiche fatte

Lo spec è stato provato qui costruendo SRPM e RPM veri in un container Fedora: contenuto del pacchetto
(`/usr/bin/anisat-feed`, `.desktop`, metainfo AppStream, icona, licenza, README) e build
`--target aarch64` funzionanti. Quello che non posso provare da qui è il build dentro le chroot di
COPR: se qualcosa non torna, l'errore compare nel log del build sul sito.
