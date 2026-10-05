from __future__ import annotations

import argparse
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import shiboken6
from PySide6.QtCore import QObject, QPoint, QSize, QTimer, Qt, qInstallMessageHandler
from PySide6.QtGui import QGuiApplication, QResizeEvent
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuick import QQuickItem
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

from test_external_players import RecordingPlayer
from watchalong.controller import AppController
from watchalong.settings import SettingsController


class UiPlayer(RecordingPlayer):
    def set_video_output(self, item):
        self.video_output = item


def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--screenshots", type=Path)
    arguments = parser.parse_args()
    QQuickStyle.setStyle("Material")
    gui = QGuiApplication(["watchalong-ui-check", "-platform", "offscreen"])
    warnings: list[str] = []

    def message_handler(kind, context, message):
        if "file:" in message or "qrc:" in message or "binding loop" in message.lower():
            warnings.append(message)

    qInstallMessageHandler(message_handler)
    with tempfile.TemporaryDirectory() as directory:
        preferences = SettingsController(Path(directory) / "settings.json")
        player = UiPlayer(42.5)
        with patch("watchalong.controller.TorrentEngine"), patch("watchalong.controller.StreamServer") as stream, patch(
            "watchalong.controller.QtMediaPlayer", return_value=player
        ):
            stream.return_value.url = "http://127.0.0.1/video"
            controller = AppController(settings=preferences)
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("app", controller)
        engine.rootContext().setContextProperty("preferences", preferences)
        engine.load(str(Path(__file__).parents[1] / "src/watchalong/ui/Main.qml"))
        assert engine.rootObjects(), "Main QML did not load"
        window = engine.rootObjects()[0]

        def settle(milliseconds=100):
            QTimer.singleShot(milliseconds, gui.quit)
            gui.exec()

        def screenshot(name):
            image = window.grabWindow()
            assert not image.isNull(), "Window was blank"
            assert image.pixelColor(5, 5).isValid()
            if arguments.screenshots:
                arguments.screenshots.mkdir(parents=True, exist_ok=True)
                image.save(str(arguments.screenshots / f"{name}.png"))

        def resize(width, height):
            previous = window.size()
            window.resize(width, height)
            QGuiApplication.sendEvent(window, QResizeEvent(QSize(width, height), previous))
            settle(150)
            assert window.property("contentItem").width() == width
            assert window.property("contentItem").height() == height

        def click_position(item):
            point = item.mapToScene(item.boundingRect().center())
            return QPoint(round(point.x()), round(point.y()))

        def visual_item(name):
            pending = [window.contentItem()]
            while pending:
                item = pending.pop()
                if item.objectName() == name and item.isVisible():
                    return item
                pending.extend(item.childItems())
            return None

        settle(350)
        settings = window.findChild(QObject, "settingsDialog")
        assert settings.property("opened"), "First-run modal was not opened"
        screenshot("setup-dark")
        resize(720, 480)
        screenshot("setup-compact")
        resize(1180, 720)
        assert preferences.save({"username": "Host", "soundsEnabled": False}, True)
        settings.close()
        settle()
        screenshot("join-dark")

        controller._player = player
        controller._connected = True
        controller._is_host = True
        controller._pending_room_code = "movie-night"
        controller._state.host_id = controller._self_id
        controller._state.session = "session"
        controller._state.media_id = "movie"
        controller._state.media_magnet = "magnet:test"
        controller._state.media_name = "A Very Long Film Name That Must Never Overlap Playback Controls.mkv"
        controller._roster.announce(controller._self_id, "Host", time.monotonic(), controller._instance)
        guest = controller._roster.announce("guest", "Guest With A Long Name", time.monotonic(), "guest-instance")
        guest.loaded = True
        controller._update_participants()
        settle()
        screenshot("room-dark-wide")
        row = visual_item("participantHold_guest")
        assert row is not None and row.isVisible(), "Participant actions were not visible"
        position = click_position(row)
        QTest.mousePress(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, position)
        settle(400)
        assert 0 < row.property("progress") < 1
        QTest.mouseRelease(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, position)
        assert "guest" in controller._roster.members, "Early release unexpectedly kicked the participant"
        assert not guest.ignored, "Cancelled hold unexpectedly toggled ignore"
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, position)
        assert guest.ignored, "Short click did not toggle ignore"
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, position)
        assert not guest.ignored

        row.forceActiveFocus()
        ready_before = controller.selfReady
        QTest.keyPress(window, Qt.Key.Key_Space)
        settle(400)
        assert 0 < row.property("progress") < 1
        QTest.keyRelease(window, Qt.Key.Key_Space)
        assert "guest" in controller._roster.members and not guest.ignored
        assert controller.selfReady == ready_before, "Hold key also triggered room readiness"

        QTest.mousePress(window, Qt.MouseButton.RightButton, Qt.KeyboardModifier.NoModifier, position)
        settle(1300)
        QTest.mouseRelease(window, Qt.MouseButton.RightButton, Qt.KeyboardModifier.NoModifier, position)
        settle(300)
        dialogs = window.findChildren(QObject, "moderationConfirmation")
        confirmation = next(dialog for dialog in dialogs if dialog.property("opened"))
        screenshot("transfer-confirmation")
        confirmation.close()
        settle()

        controller._state.phase = "countdown"
        controller._deadline = time.monotonic() + 1.5
        controller.countdownChanged.emit()
        controller._notify()
        settle(50)
        countdown = window.findChild(QObject, "countdownOverlay")
        assert countdown.property("seconds") == 1
        assert 0.35 < countdown.property("fraction") < 0.65
        screenshot("countdown-half")

        controller._state.phase = "paused"
        controller._deadline = 0
        controller._player_key = "vlc"
        player.loaded = False
        controller._player_loading = True
        controller._notify()
        settle()
        assert window.findChild(QObject, "playerLoadingSpinner").property("running")
        screenshot("external-loading")
        player.loaded = True
        controller._player_loading = False
        controller._notify()
        resize(720, 480)
        screenshot("room-dark-compact")
        preferences.previewTheme("Light")
        settle()
        screenshot("room-light-compact")

        resize(1180, 720)
        controller._player_key = "builtin"
        preferences.cancelPreview()
        controller._notify()
        settle()
        row = visual_item("participantHold_guest")
        position = click_position(row)
        QTest.mousePress(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, position)
        settle(1300)
        QTest.mouseRelease(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, position)
        assert "guest" not in controller._roster.members, "Completed hold did not remove the participant"

        shiboken6.delete(engine)
        controller.shutdown()
    qInstallMessageHandler(None)
    assert not warnings, "\n".join(warnings)
    print("QML screens, responsive layouts, hold cancellation/completion, and countdown pie passed")


if __name__ == "__main__":
    run()