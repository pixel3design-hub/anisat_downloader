#!/usr/bin/env bash
# Crea un repository dnf locale con i pacchetti di anisat-feed, così valgono le
# normali regole di dnf: `dnf search anisat`, `dnf install anisat-feed`,
# `dnf upgrade anisat-feed` (che sostituisce la versione vecchia).
#
# Uso:
#   ./packaging/setup-local-repo.sh                 # usa ~/Downloads
#   ./packaging/setup-local-repo.sh /percorso/rpm   # cartella con gli .rpm
#   ./packaging/setup-local-repo.sh --fetch         # scarica l'ultima release da GitHub
set -euo pipefail

REPO_ID="anisat"
DIR=""
FETCH=0

for arg in "$@"; do
  case "$arg" in
    --fetch) FETCH=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) DIR="$arg" ;;
  esac
done

DIR="${DIR:-$HOME/Downloads}"

if [ "$FETCH" = 1 ] || ! compgen -G "$DIR/anisat-feed-*.rpm" >/dev/null; then
  DIR="$HOME/Downloads/anisat-repo"
  mkdir -p "$DIR"
  if command -v gh >/dev/null 2>&1; then
    echo "scarico gli rpm dell'ultima release in $DIR"
    gh release download --repo pixel3design-hub/anisat_downloader --pattern '*.rpm' --dir "$DIR" --clobber
  else
    echo "gh non è installato: scarica a mano l'ultimo .rpm in $DIR" >&2
    exit 1
  fi
fi

mkdir -p "$DIR"
mapfile -t RPMS < <(find "$DIR" -maxdepth 1 -name 'anisat-feed-*.rpm' | sort)
if [ "${#RPMS[@]}" -eq 0 ]; then
  echo "nessun anisat-feed-*.rpm in $DIR" >&2
  exit 1
fi
echo "pacchetti trovati: ${#RPMS[@]}"

# createrepo_c può mancare: in quel caso si usa un container, se c'è
if command -v createrepo_c >/dev/null 2>&1; then
  createrepo_c --quiet "$DIR"
elif command -v createrepo >/dev/null 2>&1; then
  createrepo --quiet "$DIR"
elif command -v podman >/dev/null 2>&1; then
  echo "createrepo_c non installato: uso un container podman"
  podman run --rm -v "$DIR:/repo:z" registry.fedoraproject.org/fedora:latest \
    sh -c 'dnf -y -q install createrepo_c >/dev/null && createrepo_c --quiet /repo'
else
  echo "serve createrepo_c: sudo dnf install createrepo_c" >&2
  exit 1
fi

REPO_FILE="/tmp/${REPO_ID}.repo"
cat > "$REPO_FILE" <<EOF
[$REPO_ID]
name=AniSat Feed (repository locale)
baseurl=file://$DIR
enabled=1
gpgcheck=0
skip_if_unavailable=1
EOF

echo
echo "repository pronto: file://$DIR"
cat "$REPO_FILE"
echo
echo "attivalo con:"
echo "  sudo install -m644 $REPO_FILE /etc/yum.repos.d/${REPO_ID}.repo"
echo
echo "poi: dnf search anisat · dnf install anisat-feed · dnf upgrade anisat-feed"
