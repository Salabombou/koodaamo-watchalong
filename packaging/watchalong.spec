# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Koodaamo Watchalong Windows/Linux executables.

Build:
    pyinstaller packaging/watchalong.spec --noconfirm

Output (see WATCHALONG_BUNDLE below):
    dist/KoodaamoWatchalong[.exe]        (single-file, windowed)
    dist/KoodaamoWatchalong-onedir/      (unpacked bundle, used for the AppImage)
"""

from pathlib import Path

import os
import sys

from PyInstaller.utils.hooks import collect_all, copy_metadata

# --- Paths ------------------------------------------------------------------
SPEC_DIR = Path(SPECPATH)  # noqa: F821 - injected by PyInstaller
PROJECT_ROOT = SPEC_DIR.parent
SRC_DIR = PROJECT_ROOT / "src"
UI_DIR = SRC_DIR / "watchalong" / "ui"
ENTRY = SPEC_DIR / "entry.py"

# --- Collect dependencies that ship data / plugins / native libraries -------
datas = [(str(UI_DIR), "watchalong/ui")]
datas += copy_metadata("Pillow") + copy_metadata("materialyoucolor")
binaries = []
hiddenimports = ["watchalong"]

# The installer variant bundles a generated marker module so the running app
# knows it should perform forced auto-updates (see scripts/build-windows.ps1).
if os.environ.get("WATCHALONG_VARIANT") == "installer":
    hiddenimports.append("watchalong._build_variant")

for pkg in ("PySide6", "libtorrent"):
    pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
    datas += pkg_datas
    binaries += pkg_binaries
    hiddenimports += pkg_hidden

# --- Prune Qt components the app never loads --------------------------------
# These fragments are matched against the *final* Analysis TOC (below). Qt hooks
# and binary-dependency analysis pull large Qt libraries in regardless of the
# collected lists above; the 195 MB Qt6WebEngineCore.dll is the worst offender.
_EXCLUDE_FRAGMENTS = (
    "webengine", "quick3d", "3dcore", "3drender", "3dinput", "3dlogic",
    "3danimation", "3dextras", "3dquick", "charts", "datavisualization",
    "qt6graphs", "designer", "uitools", "qt6help", "quicktest", "qmltest",
    "sqldrivers", "qt6pdf", "pdfquick", "sensors", "serialport", "bluetooth",
    "qt6nfc", "positioning", "qt6location", "websockets", "webchannel",
    "networkauth", "printsupport", "quickwidgets", "translations",
)


def _keep(dest: str) -> bool:
    low = dest.replace("\\", "/").lower()
    return not any(frag in low for frag in _EXCLUDE_FRAGMENTS)


# Optional application icon: drop packaging/app.ico to brand the exe.
_icon = SPEC_DIR / "app.ico"
icon = str(_icon) if _icon.exists() else None

a = Analysis(
    [str(ENTRY)],
    pathex=[str(SRC_DIR)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "PySide6.QtWebEngineCore",
        "PySide6.QtWebEngineWidgets",
        "PySide6.QtWebEngineQuick",
        "PySide6.Qt3DCore",
        "PySide6.QtCharts",
        "PySide6.QtDataVisualization",
        "PySide6.QtQuick3D",
        "PySide6.QtPdf",
        "PySide6.QtDesigner",
        "PySide6.QtUiTools",
        "tkinter",
    ],
    noarchive=False,
)

# Prune the collected payload down to what the app actually ships.
a.binaries = [b for b in a.binaries if _keep(b[0])]
a.datas = [d for d in a.datas if _keep(d[0])]

pyz = PYZ(a.pure)

# WATCHALONG_BUNDLE selects the output layout(s) from this single analysis:
#   onefile (default) - dist/KoodaamoWatchalong[.exe]
#   onedir            - dist/KoodaamoWatchalong-onedir/ (used for the AppImage,
#                       which is already compressed and must not self-extract)
#   both              - both of the above
BUNDLE = os.environ.get("WATCHALONG_BUNDLE", "onefile")
if BUNDLE not in ("onefile", "onedir", "both"):
    raise SystemExit(f"Invalid WATCHALONG_BUNDLE: {BUNDLE!r}")

# Stripping debug symbols is safe and shrinks the Linux payload noticeably; it
# is not supported for Windows PE binaries.
STRIP = sys.platform.startswith("linux")

_exe_options = dict(
    debug=False,
    bootloader_ignore_signals=False,
    strip=STRIP,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=icon,
)

if BUNDLE in ("onefile", "both"):
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name="KoodaamoWatchalong",
        runtime_tmpdir=None,
        **_exe_options,
    )

if BUNDLE in ("onedir", "both"):
    # Distinct executable name keeps its intermediate build files separate from
    # the onefile build above.
    onedir_exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="koodaamo-watchalong",
        **_exe_options,
    )
    coll = COLLECT(
        onedir_exe,
        a.binaries,
        a.datas,
        strip=STRIP,
        upx=False,
        name="KoodaamoWatchalong-onedir",
    )
