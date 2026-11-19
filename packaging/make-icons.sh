#!/usr/bin/env bash
# Rigenera le icone dell'estensione e quella dei pacchetti da icon.png (1024x1024).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f icon.png ] || { echo "serve icon.png (1024x1024) nella radice" >&2; exit 1; }

mkdir -p extension/icons
for size in 16 32 48 128; do
  ffmpeg -v error -y -i icon.png -vf "scale=${size}:${size}:flags=lanczos" -frames:v 1 \
    "extension/icons/icon${size}.png"
done
mkdir -p service/assets
ffmpeg -v error -y -i icon.png -vf "scale=256:256:flags=lanczos" -frames:v 1 packaging/icon.png
cp packaging/icon.png service/assets/icon.png
echo "icone rigenerate da icon.png"
