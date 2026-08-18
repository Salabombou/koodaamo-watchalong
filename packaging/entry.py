"""Frozen-application entry point used by PyInstaller.

PyInstaller runs the target script as ``__main__``. The package uses relative
imports, so we launch through the installed ``watchalong`` package instead of
executing ``watchalong/app.py`` directly.
"""

from watchalong.app import main

raise SystemExit(main())
