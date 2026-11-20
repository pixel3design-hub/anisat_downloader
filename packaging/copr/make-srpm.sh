#!/usr/bin/env bash
# Costruisce l'SRPM da caricare su COPR per una release.
#
#   ./packaging/copr/make-srpm.sh             # ultima release
#   ./packaging/copr/make-srpm.sh v0.6.0      # tag preciso
#
# Se rpmbuild non c'è, lo esegue dentro un container podman.
set -euo pipefail

TAG="${1:-}"
REPO="pixel3design-hub/anisat_downloader"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$ROOT/dist/copr"

command -v gh >/dev/null || { echo "serve gh (GitHub CLI)" >&2; exit 1; }

if [ -z "$TAG" ]; then
  TAG="$(gh release view --repo "$REPO" --json tagName --jq .tagName)"
fi
VERSION="${TAG#v}"
echo "release: $TAG (versione $VERSION)"

mkdir -p "$OUT/SOURCES" "$OUT/SPECS" "$OUT/SRPMS"
SPEC="$OUT/SPECS/anisat-feed.spec"
sed "s/^Version:.*/Version:        $VERSION/" "$HERE/anisat-feed.spec" > "$SPEC"

for arch in x86_64 aarch64; do
  asset="anisat-feed-${arch}-unknown-linux-gnu.tar.gz"
  echo "scarico $asset"
  gh release download "$TAG" --repo "$REPO" --pattern "$asset" --dir "$OUT/SOURCES" --clobber
done

if command -v rpmbuild >/dev/null 2>&1; then
  rpmbuild -bs --define "_topdir $OUT" "$SPEC"
elif command -v podman >/dev/null 2>&1; then
  echo "rpmbuild non installato: uso un container podman"
  podman run --rm -v "$OUT:/work:z" -w /work registry.fedoraproject.org/fedora:latest \
    sh -c 'dnf -y -q install rpm-build >/dev/null && rpmbuild -bs --define "_topdir /work" /work/SPECS/anisat-feed.spec'
else
  echo "serve rpm-build: sudo dnf install rpm-build" >&2
  exit 1
fi

SRPM="$(find "$OUT/SRPMS" -name 'anisat-feed-*.src.rpm' | head -1)"
echo
echo "SRPM pronto: $SRPM"
cat <<EOF

Per pubblicarlo su COPR:
  copr-cli create anisat-feed --chroots fedora-43-x86_64 fedora-43-aarch64 fedora-rawhide-x86_64
  copr-cli build anisat-feed "$SRPM"

Poi gli utenti abilitano il repository con:
  sudo dnf copr enable <tuo-utente>/anisat-feed
  sudo dnf install anisat-feed
EOF
