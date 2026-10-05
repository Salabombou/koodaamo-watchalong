"""Application entry point."""

from __future__ import annotations

import logging
import os
import signal
import sys

from PySide6.QtCore import QTimer
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle

from .controller import AppController
from .settings import SettingsController


def _ui_dir() -> str:
    """Directory holding the QML UI, in both source and PyInstaller runs."""
    if getattr(sys, "frozen", False):
        base = getattr(sys, "_MEIPASS", os.path.dirname(__file__))
        return os.path.join(base, "watchalong", "ui")
    return os.path.join(os.path.dirname(__file__), "ui")


def _install_signal_handlers(app: QGuiApplication) -> QTimer:
    """Let Ctrl+C / SIGTERM quit the Qt event loop.

    Python signal handlers do not run while Qt's C++ loop blocks, so a periodic
    no-op timer is used to give the interpreter a chance to deliver signals.
    """
    for sig in (signal.SIGINT, getattr(signal, "SIGTERM", signal.SIGINT)):
        try:
            signal.signal(sig, lambda *_: app.quit())
        except (ValueError, OSError):  # pragma: no cover - not main thread
            pass
    wakeup = QTimer()
    wakeup.setInterval(200)
    wakeup.timeout.connect(lambda: None)
    wakeup.start()
    return wakeup


def _run_forced_update_if_needed(app: QGuiApplication, preferences: SettingsController) -> bool:
    """Installer builds only: block on launch to apply a mandatory update.

    Returns ``True`` if an update was launched and the app should exit, or
    ``False`` to continue starting normally (no update, or the check failed).
    """
    try:
        from .update import check_for_update, UpdateController
    except Exception:  # pragma: no cover - update deps missing
        return False
    info = check_for_update()
    if info is None:
        return False

    controller = UpdateController(info)
    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("updater", controller)
    engine.rootContext().setContextProperty("preferences", preferences)
    engine.load(os.path.join(_ui_dir(), "Updating.qml"))
    if not engine.rootObjects():
        return False
    controller.finished.connect(app.quit)
    controller.start()
    app.exec()
    return controller.launched


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # Modern Material look for the Qt Quick Controls; the QML sets dark + accent.
    QQuickStyle.setStyle("Material")

    app = QGuiApplication(sys.argv)
    app.setApplicationName("koodaamo-watchalong")
    app.setOrganizationName("Koodaamo")
    app.setQuitOnLastWindowClosed(True)

    preferences = SettingsController()
    if _run_forced_update_if_needed(app, preferences):
        return 0

    controller = AppController(settings=preferences)

    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("app", controller)
    engine.rootContext().setContextProperty("preferences", preferences)

    qml_path = os.path.join(_ui_dir(), "Main.qml")
    engine.load(qml_path)
    if not engine.rootObjects():
        logging.getLogger(__name__).error("Failed to load QML: %s", qml_path)
        return 1

    app.aboutToQuit.connect(controller.shutdown)
    _wakeup = _install_signal_handlers(app)  # noqa: F841 - keep alive
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
