#!/usr/bin/env bash
# Costruisce anisat-feed-x86_64.AppImage dal binario già compilato.
# Uso: VERSION=0.1.0 ./packaging/appimage.sh path/al/anisat-feed [cartella-uscita]
set -euo pipefail

BIN="${1:?uso: appimage.sh <binario> [out-dir]}"
OUT="${2:-dist}"
VERSION="${VERSION:-0.1.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v "$BIN" >/dev/null 2>&1 || [ -x "$BIN" ] || { echo "binario non trovato: $BIN" >&2; exit 1; }

WORK="$(mktemp -d)"
APPDIR="$WORK/AniSatFeed.AppDir"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/icons/hicolor/256x256/apps" "$OUT"

install -m755 "$BIN" "$APPDIR/usr/bin/anisat-feed"
install -m644 "$ROOT/packaging/icon.png" "$APPDIR/anisat-feed.png"
install -m644 "$ROOT/packaging/icon.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/anisat-feed.png"
install -m644 "$ROOT/COPYING" "$APPDIR/COPYING"

cat > "$APPDIR/anisat-feed.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=AniSat Feed
Comment=Feed RSS locale per AniSat Downloader
Exec=anisat-feed
Icon=anisat-feed
Terminal=true
Categories=Network;
EOF

TOOL="$WORK/appimagetool"
if ! command -v appimagetool >/dev/null 2>&1; then
  curl -sSL -o "$TOOL" \
    https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
  chmod +x "$TOOL"
else
  TOOL="$(command -v appimagetool)"
fi

ARCH=x86_64 VERSION="$VERSION" "$TOOL" --no-appstream "$APPDIR" "$OUT/anisat-feed-x86_64.AppImage"
echo "creato $OUT/anisat-feed-x86_64.AppImage"
