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


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # Modern Material look for the Qt Quick Controls; the QML sets dark + accent.
    QQuickStyle.setStyle("Material")

    app = QGuiApplication(sys.argv)
    app.setApplicationName("Koodaamo Watchalong")
    app.setQuitOnLastWindowClosed(True)

    controller = AppController()

    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("app", controller)

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
