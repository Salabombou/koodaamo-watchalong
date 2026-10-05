from __future__ import annotations

import argparse
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import shiboken6
from PIL import Image
from PySide6.QtCore import QObject, QPoint, QSize, QTimer, Qt, qInstallMessageHandler
from PySide6.QtGui import QGuiApplication, QResizeEvent
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuick import QQuickItem
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

from test_external_players import RecordingPlayer
from watchalong.app import _ui_dir
from watchalong.controller import AppController
from watchalong.settings import SettingsController
from watchalong.theme_generator import ThemeGenerationController


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
        generator = ThemeGenerationController()
        player = UiPlayer(42.5)
        with patch("watchalong.controller.TorrentEngine"), patch("watchalong.controller.StreamServer") as stream, patch(
            "watchalong.controller.QtMediaPlayer", return_value=player
        ):
            stream.return_value.url = "http://127.0.0.1/video"
            controller = AppController(settings=preferences)
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("app", controller)
        engine.rootContext().setContextProperty("preferences", preferences)
        engine.rootContext().setContextProperty("themeGenerator", generator)
        engine.load(str(Path(_ui_dir()) / "Main.qml"))
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

        def variant(value):
            return value.toVariant() if hasattr(value, "toVariant") else value

        def wait_for_generation():
            deadline = time.monotonic() + 10
            while generator.busy and time.monotonic() < deadline:
                settle(30)
            assert not generator.busy, "Theme generation timed out"
            settle(150)

        settings.open()
        settle(250)
        editor = window.findChild(QObject, "themeEditor")
        editor.edit("Dark", True)
        settle(250)
        creation_tabs = window.findChild(QObject, "themeCreationTabs")
        mode_choice = window.findChild(QObject, "themeModeChoice")
        name_field = window.findChild(QObject, "themeNameField")
        save_theme = window.findChild(QObject, "saveGeneratedTheme")
        assert creation_tabs.property("currentIndex") == 0
        creation_tabs.setProperty("currentIndex", 1)
        editor.shuffle()
        name_field.setProperty("text", "Ocean night")
        assert generator.busy
        assert not save_theme.property("enabled")
        assert window.findChild(QObject, "themeGenerationSpinner").property("running")
        wait_for_generation()
        assert not generator.errorMessage, generator.errorMessage
        random_candidates = variant(editor.property("randomCandidates"))
        assert len(random_candidates) == 6
        assert name_field.property("text") == "Ocean night", "Generation replaced the typed name"
        candidate = visual_item("randomPalette_1")
        assert candidate is not None
        screenshot("theme-random-before-selection")
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, click_position(candidate))
        settle(100)
        assert preferences.palette == random_candidates[1]["dark"]["colors"], (
            f"selected={editor.property('selectedSeed')}, expected={random_candidates[1]['seed']}, "
            f"dark={editor.property('darkMode')}, bounds={candidate.boundingRect()}, point={click_position(candidate)}, "
            f"editor={editor.property('width')}x{editor.property('height')}, warnings={warnings}"
        )
        screenshot("theme-random-dark")
        mode_choice.setProperty("currentIndex", 1)
        settle()
        assert preferences.palette == random_candidates[1]["light"]["colors"], (
            f"mode={mode_choice.property('currentIndex')}, dark={editor.property('darkMode')}, "
            f"dirty={editor.property('manualDirty')}, closing={editor.property('closing')}, "
            f"actual={preferences.palette}, expected={random_candidates[1]['light']['colors']}, warnings={warnings}"
        )
        screenshot("theme-random-light")
        editor.shuffle()
        wait_for_generation()
        assert len(variant(editor.property("randomHistory"))) == 1
        editor.previousBatch()
        assert variant(editor.property("randomCandidates")) == random_candidates
        resize(720, 480)
        screenshot("theme-random-compact")
        assert save_theme.isVisible()
        assert click_position(save_theme).y() < editor.property("y") + editor.property("height") - 8, "Save control escaped editor bounds"
        assert editor.property("y") >= 0 and editor.property("y") + editor.property("height") <= window.height(), "Editor escaped window bounds"
        resize(1180, 720)

        source_image = Path(directory) / "palette.png"
        image = Image.new("RGB", (160, 80), "#237A64")
        image.paste("#DD5533", (0, 0, 60, 80))
        image.save(source_image)
        creation_tabs.setProperty("currentIndex", 0)
        editor.generateImage(source_image.as_uri())
        wait_for_generation()
        assert not generator.errorMessage, generator.errorMessage
        image_candidates = variant(editor.property("imageCandidates"))
        assert len(image_candidates) >= 2
        thumbnail = window.findChild(QObject, "themeSourceThumbnail")
        assert editor.property("imageReady"), "Source thumbnail did not render"
        assert thumbnail.isVisible()
        screenshot("theme-image")
        original_thumbnail = editor.property("imageThumbnail")
        source_image.unlink()
        style_choice = window.findChild(QObject, "themeStyleChoice")
        style_choice.setProperty("currentIndex", 1)
        editor.regenerate()
        wait_for_generation()
        assert not generator.errorMessage, "Style change reread the removed image"
        assert editor.property("imageThumbnail") == original_thumbnail

        creation_tabs.setProperty("currentIndex", 2)
        editor.generateColor("#QQQQQQ")
        wait_for_generation()
        assert generator.errorMessage
        screenshot("theme-invalid-color")
        source_color = window.findChild(QObject, "themeSourceColor")
        source_color.setProperty("text", "#2E759B")
        source_color.forceActiveFocus()
        request_before = generator._request_id
        QTest.keyClick(window, Qt.Key.Key_End)
        QTest.keyClick(window, Qt.Key.Key_Backspace)
        QTest.keyClick(window, Qt.Key.Key_B)
        settle(350)
        wait_for_generation()
        assert not generator.errorMessage, generator.errorMessage
        assert editor.property("selectedSeed") == "#2E759B"
        assert generator._request_id == request_before + 2, "Color edit submitted duplicate requests"
        screenshot("theme-color")
        creation_tabs.setProperty("currentIndex", 3)
        editor.setColor("accent", "#CC3366")
        assert editor.property("manualDirty")
        assert preferences.palette["accent"] == "#CC3366"
        screenshot("theme-manual")
        editor.shuffle()
        confirmation = window.findChild(QObject, "replaceThemeDraft")
        settle(350)
        assert confirmation.property("opened"), f"visible={confirmation.property('visible')}, dirty={editor.property('manualDirty')}, warnings={warnings}"
        confirmation.reject()
        settle(350)
        assert preferences.palette["accent"] == "#CC3366"
        editor.shuffle()
        settle(350)
        confirmation.accept()
        wait_for_generation()
        assert not editor.property("manualDirty")
        assert name_field.property("text") == "Ocean night"
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, click_position(save_theme))
        settle(300)
        assert not editor.property("opened")
        assert preferences.values["themeName"] == "Ocean night"
        saved_palette = preferences.palette
        editor.edit("Ocean night", False)
        settle(200)
        assert creation_tabs.property("currentIndex") == 3
        editor.generateColor("#FF3300")
        editor.close()
        settle(400)
        assert not generator.busy
        assert preferences.palette == saved_palette, "Closed editor accepted a late result"
        editor.edit("Ocean night", True)
        settle(200)
        editor.setColor("accent", "#AA1133")
        QTest.keyClick(window, Qt.Key.Key_Escape)
        settle(250)
        assert not editor.property("opened")
        assert preferences.palette == saved_palette, "Escape did not restore the selected theme"
        settings.close()
        preferences.previewTheme("Dark")
        settle(250)

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
        generator.shutdown()
        generator.wait_for_shutdown()
        controller.shutdown()
    qInstallMessageHandler(None)
    assert not warnings, "\n".join(warnings)
    print("QML screens, quick theme generation, responsive layouts, hold cancellation/completion, and countdown pie passed")


if __name__ == "__main__":
    run()