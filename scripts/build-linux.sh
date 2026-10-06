#!/usr/bin/env bash
#
# Build the Koodaamo Watchalong Linux release artifacts with PyInstaller:
#   - dist/KoodaamoWatchalong-linux-<arch>      (portable single-file binary)
#   - dist/KoodaamoWatchalong-<arch>.AppImage   (universal desktop bundle)
#
# A single PyInstaller analysis produces both layouts. The AppImage wraps the
# unpacked onedir bundle rather than the single-file binary: the AppImage is
# already a compressed squashfs, so this avoids double compression and the
# per-launch extraction of the whole app into /tmp.
#
# The Windows-only auto-updating "installer" variant does not apply on Linux, so
# both artifacts are plain portable builds.
#
# Usage:
#   scripts/build-linux.sh [--variant portable|appimage|both] [--clean] [--no-install]
set -euo pipefail

VARIANT="both"
CLEAN=0
INSTALL=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant)    VARIANT="${2:?missing value for --variant}"; shift 2 ;;
    --clean)      CLEAN=1; shift ;;
    --no-install) INSTALL=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$VARIANT" in
  portable) BUNDLE="onefile" ;;
  appimage) BUNDLE="onedir" ;;
  both)     BUNDLE="both" ;;
  *) echo "Invalid --variant: $VARIANT (expected portable|appimage|both)" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARCH="$(uname -m)"
BIN_NAME="KoodaamoWatchalong"
ONEDIR="dist/${BIN_NAME}-onedir"
ONEDIR_EXE="koodaamo-watchalong"

app_version() {
  sed -n 's/^APP_VERSION[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' \
    src/watchalong/config.py | head -n1
}

build_bundles() {
  echo "==> Building Linux bundle(s) with PyInstaller ($BUNDLE) ..."
  rm -rf "dist/$BIN_NAME" "$ONEDIR"
  WATCHALONG_VARIANT=portable WATCHALONG_BUNDLE="$BUNDLE" \
    pyinstaller packaging/watchalong.spec --noconfirm
}

finish_portable() {
  local out="dist/${BIN_NAME}-linux-${ARCH}"
  if [[ ! -f "dist/$BIN_NAME" ]]; then
    echo "PyInstaller did not produce dist/$BIN_NAME" >&2
    exit 1
  fi
  mv -f "dist/$BIN_NAME" "$out"
  chmod +x "$out"
  echo "Built: $out (v$(app_version))"
}

build_appimage() {
  local appdir="build/AppDir"
  local out="dist/${BIN_NAME}-${ARCH}.AppImage"
  local libdir="usr/lib/koodaamo-watchalong"
  if [[ ! -x "$ONEDIR/$ONEDIR_EXE" ]]; then
    echo "PyInstaller did not produce $ONEDIR/$ONEDIR_EXE" >&2
    exit 1
  fi
  echo "==> Building AppImage ..."
  rm -rf "$appdir"
  mkdir -p "$appdir/usr/lib" "$appdir/usr/share/applications" \
    "$appdir/usr/share/icons/hicolor/scalable/apps"
  cp -a "$ONEDIR" "$appdir/$libdir"

  # Icon: appimagetool accepts the SVG directly, so no rasterisation is needed.
  cp packaging/watchalong.svg "$appdir/koodaamo-watchalong.svg"
  cp packaging/watchalong.svg "$appdir/.DirIcon"
  cp packaging/watchalong.svg "$appdir/usr/share/icons/hicolor/scalable/apps/koodaamo-watchalong.svg"
  cp packaging/watchalong.desktop "$appdir/koodaamo-watchalong.desktop"
  cp packaging/watchalong.desktop "$appdir/usr/share/applications/koodaamo-watchalong.desktop"

  cat > "$appdir/AppRun" <<EOF
#!/bin/sh
HERE="\$(dirname "\$(readlink -f "\$0")")"
exec "\$HERE/$libdir/$ONEDIR_EXE" "\$@"
EOF
  chmod +x "$appdir/AppRun"

  # Fetch appimagetool once, cached under build/.
  local tool="build/appimagetool-${ARCH}.AppImage"
  if [[ ! -x "$tool" ]]; then
    echo "==> Downloading appimagetool ..."
    mkdir -p build
    curl -fsSL -o "$tool" \
      "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${ARCH}.AppImage"
    chmod +x "$tool"
  fi

  # APPIMAGE_EXTRACT_AND_RUN avoids requiring FUSE on CI runners. zstd gives a
  # good size/startup-speed trade-off for the squashfs payload.
  rm -f "$out"
  ARCH="$ARCH" VERSION="$(app_version)" APPIMAGE_EXTRACT_AND_RUN=1 \
    "$tool" --no-appstream --comp zstd "$appdir" "$out"
  if [[ ! -f "$out" ]]; then
    echo "appimagetool did not produce $out" >&2
    exit 1
  fi
  chmod +x "$out"
  echo "Built: $out (v$(app_version))"
}

if [[ "$CLEAN" == "1" ]]; then
  echo "==> Cleaning build/ and dist/ ..."
  rm -rf build dist
fi

if [[ "$INSTALL" == "1" ]]; then
  echo "==> Installing build dependencies ..."
  python -m pip install --upgrade pip
  python -m pip install -e '.[build]'
fi

build_bundles
if [[ "$BUNDLE" == "onefile" || "$BUNDLE" == "both" ]]; then finish_portable; fi
if [[ "$BUNDLE" == "onedir" || "$BUNDLE" == "both" ]]; then build_appimage; fi
echo "==> Done."