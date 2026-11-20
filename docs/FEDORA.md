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

## COPR (per avere il repository ufficiale)

Mozilla non c'entra, COPR è il servizio Fedora per repository personali: con un account su
<https://copr.fedorainfracloud.org> si pubblica un repository `dnf copr enable <utente>/anisat` e
`dnf search`/`upgrade` funzionano come per qualsiasi pacchetto Fedora. Non è ancora configurato qui:
richiede un account e un `.spec` che compili dai sorgenti, oppure (più semplice per un binario già
pronto) un pacchetto che installi l'eseguibile della release. Se serve, è il passo successivo.
