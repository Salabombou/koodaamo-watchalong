#!/usr/bin/env bash
#
# Build the Koodaamo Watchalong Linux binary with PyInstaller and package it as
# the two most common portable Linux formats:
#   - dist/KoodaamoWatchalong-linux-<arch>.tar.gz   (portable binary tarball)
#   - dist/KoodaamoWatchalong-<arch>.AppImage        (universal desktop bundle)
#
# The Windows-only auto-updating "installer" variant does not apply on Linux, so
# both artifacts are plain portable builds.
#
# Usage:
#   scripts/build-linux.sh [--variant portable|appimage|both] [--clean]
set -euo pipefail

VARIANT="both"
CLEAN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant) VARIANT="${2:?missing value for --variant}"; shift 2 ;;
    --clean)   CLEAN=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$VARIANT" in
  portable|appimage|both) ;;
  *) echo "Invalid --variant: $VARIANT (expected portable|appimage|both)" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARCH="$(uname -m)"
BIN_NAME="KoodaamoWatchalong"

app_version() {
  sed -n 's/^APP_VERSION[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
    src/watchalong/config.py | head -n1
}

build_binary() {
  echo "==> Building Linux binary with PyInstaller ..."
  WATCHALONG_VARIANT=portable pyinstaller packaging/watchalong.spec --noconfirm
  if [[ ! -f "dist/$BIN_NAME" ]]; then
    echo "PyInstaller did not produce dist/$BIN_NAME" >&2
    exit 1
  fi
  chmod +x "dist/$BIN_NAME"
  echo "Built: dist/$BIN_NAME"
}

build_tarball() {
  local out="dist/${BIN_NAME}-linux-${ARCH}.tar.gz"
  echo "==> Packaging portable tarball -> $out"
  tar -C dist -czf "$out" "$BIN_NAME"
  echo "Built: $out (v$(app_version))"
}

build_appimage() {
  local appdir="build/AppDir"
  local out="dist/${BIN_NAME}-${ARCH}.AppImage"
  echo "==> Building AppImage ..."
  rm -rf "$appdir"
  mkdir -p "$appdir/usr/bin"
  cp "dist/$BIN_NAME" "$appdir/usr/bin/$BIN_NAME"
  chmod +x "$appdir/usr/bin/$BIN_NAME"

  # Icon: appimagetool accepts the SVG directly, so no rasterisation is needed.
  cp packaging/watchalong.svg "$appdir/koodaamo-watchalong.svg"
  cp packaging/watchalong.svg "$appdir/.DirIcon"

  cp packaging/watchalong.desktop "$appdir/koodaamo-watchalong.desktop"

  cat > "$appdir/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/KoodaamoWatchalong" "$@"
EOF
  chmod +x "$appdir/AppRun"

  # Fetch appimagetool once, cached under build/.
  local tool="build/appimagetool-${ARCH}.AppImage"
  if [[ ! -x "$tool" ]]; then
    echo "==> Downloading appimagetool ..."
    curl -fsSL -o "$tool" \
      "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${ARCH}.AppImage"
    chmod +x "$tool"
  fi

  # APPIMAGE_EXTRACT_AND_RUN avoids requiring FUSE on CI runners.
  ARCH="$ARCH" APPIMAGE_EXTRACT_AND_RUN=1 "$tool" "$appdir" "$out"
  if [[ ! -f "$out" ]]; then
    echo "appimagetool did not produce $out" >&2
    exit 1
  fi
  echo "Built: $out (v$(app_version))"
}

if [[ "$CLEAN" == "1" ]]; then
  echo "==> Cleaning build/ and dist/ ..."
  rm -rf build dist
fi

echo "==> Installing build dependencies ..."
python -m pip install --upgrade pip
python -m pip install -e '.[build]'

build_binary
if [[ "$VARIANT" == "portable" || "$VARIANT" == "both" ]]; then build_tarball; fi
if [[ "$VARIANT" == "appimage" || "$VARIANT" == "both" ]]; then build_appimage; fi
echo "==> Done."
