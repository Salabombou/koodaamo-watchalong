from __future__ import annotations

import json
import os
import queue
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from typing import Callable
from unittest.mock import Mock, patch

import requests
from PySide6.QtCore import QCoreApplication
from PySide6.QtMultimedia import QMediaPlayer

from watchalong.controller import AppController
from watchalong.players.base import Player
from watchalong.players.mpv_external import MpvExternalPlayer, _IpcTransport
from watchalong.players.qt_media import QtMediaPlayer
from watchalong.players.vlc_external import VlcExternalPlayer, _find_vlc


class RecordingPlayer(Player):
    def __init__(self, position: float = 0.0) -> None:
        super().__init__()
        self.position = position
        self.loaded = True
        self.error = ""
        self.calls: list[tuple] = []

    def load(self, url: str) -> None:
        self.calls.append(("load", url))

    def pause(self) -> None:
        self.calls.append(("pause",))

    def play(self) -> None:
        self.calls.append(("play",))

    def seek(self, seconds: float) -> None:
        self.calls.append(("seek", seconds))
        self.position = seconds

    def set_volume(self, percent: float) -> None:
        self.calls.append(("volume", percent))

    def get_position(self) -> float:
        return self.position

    def is_loaded(self) -> bool:
        return self.loaded

    def get_error(self) -> str:
        return self.error

    def shutdown(self) -> None:
        self.calls.append(("shutdown",))


class ExternalPlayerTests(unittest.TestCase):
    def test_vlc_discovery_resolves_scoop_launcher(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            launcher = Path(directory) / "vlc.exe"
            binary = Path(directory) / "app" / "vlc.exe"
            binary.parent.mkdir()
            binary.touch()
            launcher.with_suffix(".shim").write_text(f'path = "{binary}"\n', encoding="utf-8")
            with patch("watchalong.players.vlc_external.shutil.which", return_value=str(launcher)):
                self.assertEqual(_find_vlc(), str(binary))

    def test_vlc_discovery_keeps_launcher_if_metadata_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            launcher = Path(directory) / "vlc.exe"
            launcher.with_suffix(".shim").write_text("not valid metadata\n", encoding="utf-8")
            with patch("watchalong.players.vlc_external.shutil.which", return_value=str(launcher)):
                self.assertEqual(_find_vlc(), str(launcher))

    def test_mpv_controls_do_not_wait_for_ipc(self) -> None:
        player = MpvExternalPlayer()
        write_started = threading.Event()
        release_write = threading.Event()
        transport = Mock()
        transport.connect.return_value = True

        def stalled_write(data):
            write_started.set()
            release_write.wait(2)

        transport.write.side_effect = stalled_write
        transport.read_some.return_value = None
        process = Mock()
        process.poll.return_value = None
        with patch("watchalong.players.mpv_external._find_mpv", return_value="mpv"), patch(
            "watchalong.players.mpv_external._HAVE_WIN32", True
        ), patch(
            "watchalong.players.mpv_external._IpcTransport", return_value=transport
        ), patch(
            "watchalong.players.mpv_external.subprocess.Popen", return_value=process
        ):
            try:
                player.load("http://127.0.0.1/video")
                worker = player._worker
                self.assertTrue(write_started.wait(1))
                started = time.monotonic()
                player.pause()
                player.seek(12.5)
                player.set_volume(50)
                player.get_position()
                player.get_duration()
                player.shutdown()
                self.assertLess(time.monotonic() - started, 0.2)
            finally:
                release_write.set()
                player.shutdown()
                worker.thread.join(2)
            self.assertFalse(worker.thread.is_alive())

    def test_windows_pipe_is_not_read_when_empty(self) -> None:
        transport = _IpcTransport("test-pipe")
        transport._pipe = object()
        pipe_api = Mock()
        pipe_api.PeekNamedPipe.return_value = (b"", 0, 0)
        file_api = Mock()
        with patch("watchalong.players.mpv_external.win32pipe", pipe_api, create=True), patch(
            "watchalong.players.mpv_external.win32file", file_api, create=True
        ):
            self.assertIsNone(transport.read_some())
            file_api.ReadFile.assert_not_called()

    def test_windows_pipe_reads_only_available_bytes(self) -> None:
        transport = _IpcTransport("test-pipe")
        transport._pipe = object()
        pipe_api = Mock()
        pipe_api.PeekNamedPipe.return_value = (b"", 12, 12)
        file_api = Mock()
        file_api.ReadFile.return_value = (0, b"test-message")
        with patch("watchalong.players.mpv_external.win32pipe", pipe_api, create=True), patch(
            "watchalong.players.mpv_external.win32file", file_api, create=True
        ):
            self.assertEqual(transport.read_some(), b"test-message")
            file_api.ReadFile.assert_called_once_with(transport._pipe, 12)

    def test_mpv_queues_controls_until_media_is_loaded(self) -> None:
        player = MpvExternalPlayer()
        connect_started = threading.Event()
        release_connect = threading.Event()
        controls_sent = threading.Event()
        commands: list[list] = []
        writers: set[int] = set()
        incoming: queue.Queue[bytes] = queue.Queue()
        incoming.put(b'{"event":"property-change","name":"duration","data":100}\n')
        incoming.put(b'{"event":"property-change","name":"time-pos","data":12.5}\n')

        def connect(stopped):
            connect_started.set()
            return release_connect.wait(2)

        def write(data):
            writers.add(threading.get_ident())
            command = json.loads(data)["command"]
            commands.append(command)
            if command == ["set_property", "pause", False]:
                controls_sent.set()

        def read_some():
            try:
                return incoming.get_nowait()
            except queue.Empty:
                return None

        transport = Mock(connect=connect, write=write, read_some=read_some)
        process = Mock()
        process.poll.return_value = None
        with patch("watchalong.players.mpv_external._find_mpv", return_value="mpv"), patch(
            "watchalong.players.mpv_external._HAVE_WIN32", True
        ), patch(
            "watchalong.players.mpv_external._IpcTransport", return_value=transport
        ), patch(
            "watchalong.players.mpv_external.subprocess.Popen", return_value=process
        ):
            try:
                player.load("http://127.0.0.1/video")
                worker = player._worker
                self.assertTrue(connect_started.wait(1))
                self.assertFalse(player.is_loaded())
                player.set_volume(50)
                player.seek(12.5)
                player.play()
                release_connect.set()
                self.assertTrue(controls_sent.wait(1))
                self.assertEqual(commands[2:], [
                    ["set_property", "volume", 50.0],
                    ["seek", 12.5, "absolute", "exact"],
                    ["set_property", "pause", False],
                ])
                self.assertEqual(writers, {worker.thread.ident})
                self.assertTrue(player.is_loaded())
                self.assertEqual(player.get_duration(), 100.0)
            finally:
                release_connect.set()
                player.shutdown()
                worker.thread.join(2)
            self.assertFalse(worker.thread.is_alive())

    def test_mpv_shutdown_cancels_ipc_connection(self) -> None:
        player = MpvExternalPlayer()
        connect_started = threading.Event()

        def connect(stopped):
            connect_started.set()
            stopped.wait(2)
            return False

        transport = Mock(connect=connect)
        process = Mock()
        process.poll.return_value = None
        with patch("watchalong.players.mpv_external._find_mpv", return_value="mpv"), patch(
            "watchalong.players.mpv_external._HAVE_WIN32", True
        ), patch(
            "watchalong.players.mpv_external._IpcTransport", return_value=transport
        ), patch(
            "watchalong.players.mpv_external.subprocess.Popen", return_value=process
        ):
            try:
                player.load("http://127.0.0.1/video")
                worker = player._worker
                self.assertTrue(connect_started.wait(1))
            finally:
                player.shutdown()
                worker.thread.join(1)
            self.assertFalse(worker.thread.is_alive())
            transport.write.assert_not_called()
            transport.close.assert_called_once()
            process.terminate.assert_called_once()

    def test_vlc_controls_do_not_wait_for_http(self) -> None:
        player = VlcExternalPlayer()
        request_started = threading.Event()
        release_request = threading.Event()
        response = Mock(ok=True)
        response.json.return_value = {"time": 12.5, "length": 100.0}

        def stalled_request(*args, **kwargs):
            request_started.set()
            release_request.wait(2)
            return response

        process = Mock()
        process.poll.return_value = None
        try:
            with patch("watchalong.players.vlc_external._find_vlc", return_value="vlc"), patch(
                "watchalong.players.vlc_external.subprocess.Popen", return_value=process
            ), patch(
                "watchalong.players.vlc_external.requests.Session.get", side_effect=stalled_request
            ):
                started = time.monotonic()
                player.load("http://127.0.0.1/video")
                worker = player._worker
                self.assertTrue(request_started.wait(1), "HTTP worker did not start")
                started = time.monotonic()
                player.pause()
                player.seek(12.5)
                player.set_volume(50)
                player.get_position()
                player.get_duration()
                player.shutdown()
                elapsed = time.monotonic() - started
                release_request.set()
                worker.thread.join(2)
                self.assertFalse(worker.thread.is_alive())
            self.assertLess(elapsed, 0.2, "Player controls blocked the calling thread")
        finally:
            release_request.set()
            player.shutdown()

    def test_vlc_waits_for_http_before_sending_controls(self) -> None:
        player = VlcExternalPlayer()
        http_ready = threading.Event()
        first_request = threading.Event()
        controls_sent = threading.Event()
        commands: list[dict] = []
        response = Mock(ok=True)
        response.json.return_value = {"time": 12.5, "length": 100.0}

        def status(*args, **kwargs):
            params = kwargs.get("params")
            if not http_ready.is_set():
                first_request.set()
                raise requests.ConnectionError("HTTP interface is starting")
            if params is not None:
                commands.append(params)
                if params["command"] == "pl_forceresume":
                    controls_sent.set()
            return response

        process = Mock()
        process.poll.return_value = None
        with patch("watchalong.players.vlc_external._find_vlc", return_value="vlc"), patch(
            "watchalong.players.vlc_external.subprocess.Popen", return_value=process
        ), patch("watchalong.players.vlc_external.requests.Session.get", side_effect=status):
            try:
                player.load("http://127.0.0.1/video")
                worker = player._worker
                self.assertTrue(first_request.wait(1))
                player.seek(12.5)
                player.set_volume(50)
                player.play()
                http_ready.set()
                self.assertTrue(controls_sent.wait(1))
                self.assertEqual(commands, [
                    {"command": "seek", "val": "12.5"},
                    {"command": "volume", "val": "128"},
                    {"command": "pl_forceresume"},
                ])
                self.assertEqual(player.get_position(), 12.5)
                self.assertEqual(player.get_duration(), 100.0)
            finally:
                player.shutdown()
                worker.thread.join(2)
            self.assertFalse(worker.thread.is_alive())

    def test_vlc_restart_does_not_use_previous_worker_state(self) -> None:
        player = VlcExternalPlayer()
        first_request = threading.Event()
        release_first = threading.Event()
        second_request = threading.Event()
        old_response = Mock(ok=True)
        old_response.json.return_value = {"time": 12.5, "length": 100.0}
        new_response = Mock(ok=True)
        new_response.json.return_value = {"time": 80.0, "length": 200.0}

        def stalled_status(*args, **kwargs):
            first_request.set()
            release_first.wait(2)
            return old_response

        def current_status(*args, **kwargs):
            second_request.set()
            return new_response

        old_session = Mock()
        old_session.get.side_effect = stalled_status
        new_session = Mock()
        new_session.get.side_effect = current_status
        process = Mock()
        process.poll.return_value = None
        with patch("watchalong.players.vlc_external._find_vlc", return_value="vlc"), patch(
            "watchalong.players.vlc_external.subprocess.Popen", return_value=process
        ), patch(
            "watchalong.players.vlc_external.requests.Session", side_effect=[old_session, new_session]
        ):
            try:
                player.load("http://127.0.0.1/old")
                old_worker = player._worker
                self.assertTrue(first_request.wait(1))
                player.shutdown()
                player.load("http://127.0.0.1/new")
                new_worker = player._worker
                self.assertTrue(second_request.wait(1))
                release_first.set()
                old_worker.thread.join(2)
                self.assertIsNot(old_worker, new_worker)
                self.assertEqual(player.get_position(), 80.0)
                self.assertEqual(player.get_duration(), 200.0)
                self.assertFalse(old_worker.thread.is_alive())
            finally:
                release_first.set()
                player.shutdown()
                old_worker.thread.join(2)
                new_worker.thread.join(2)
            self.assertFalse(new_worker.thread.is_alive())

    def test_vlc_waits_for_media_before_sending_seek(self) -> None:
        player = VlcExternalPlayer()
        media_ready = threading.Event()
        loading_polled = threading.Event()
        early_command = threading.Event()
        seek_sent = threading.Event()
        polls = 0

        def status(*args, **kwargs):
            nonlocal polls
            params = kwargs.get("params")
            if params is not None:
                if not media_ready.is_set():
                    early_command.set()
                if params["command"] == "seek":
                    seek_sent.set()
            else:
                polls += 1
                if polls >= 2:
                    loading_polled.set()
            response = Mock(ok=True)
            response.json.return_value = {"time": 0.0, "length": 100.0 if media_ready.is_set() else 0.0}
            return response

        process = Mock()
        process.poll.return_value = None
        with patch("watchalong.players.vlc_external._find_vlc", return_value="vlc"), patch(
            "watchalong.players.vlc_external.subprocess.Popen", return_value=process
        ), patch("watchalong.players.vlc_external.requests.Session.get", side_effect=status):
            try:
                player.load("http://127.0.0.1/video")
                worker = player._worker
                player.seek(42.5)
                player.play()
                self.assertTrue(loading_polled.wait(1))
                self.assertFalse(early_command.is_set(), "Controls were sent before VLC loaded the video")
                media_ready.set()
                self.assertTrue(seek_sent.wait(1))
            finally:
                player.shutdown()
                worker.thread.join(2)
            self.assertFalse(worker.thread.is_alive())


class QtPlayerTests(unittest.TestCase):
    def setUp(self) -> None:
        with patch("watchalong.players.qt_media.QMediaPlayer") as media, patch(
            "watchalong.players.qt_media.QAudioOutput"
        ):
            self.player = QtMediaPlayer()
            self.media = media.return_value

    def test_qt_seek_waits_for_media_to_load(self) -> None:
        self.media.mediaStatus.return_value = QMediaPlayer.MediaStatus.LoadingMedia
        self.player.seek(42.5)
        self.media.setPosition.assert_not_called()
        self.assertFalse(self.player.is_loaded())
        self.media.mediaStatus.return_value = QMediaPlayer.MediaStatus.LoadedMedia
        self.player._on_media_status(QMediaPlayer.MediaStatus.LoadedMedia)
        self.media.setPosition.assert_called_once_with(42500)
        self.assertTrue(self.player.is_loaded())

    def test_qt_load_does_not_start_playback_and_clears_errors(self) -> None:
        self.player._error = "Previous decoder error"
        self.player.load("http://127.0.0.1/video")
        self.media.play.assert_not_called()
        self.assertEqual(self.player.get_error(), "")

    def test_qt_decoder_errors_are_available_to_controller(self) -> None:
        self.player._on_error(QMediaPlayer.Error.FormatError, "Unsupported format")
        self.assertEqual(self.player.get_error(), "Unsupported format")


class PlayerSwitchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.qt_app = QCoreApplication.instance() or QCoreApplication([])

    def setUp(self) -> None:
        self.builtin = RecordingPlayer(42.5)
        with patch("watchalong.controller.TorrentEngine"), patch(
            "watchalong.controller.StreamServer"
        ) as stream, patch("watchalong.controller.QtMediaPlayer", return_value=self.builtin):
            stream.return_value.url = "http://127.0.0.1/video"
            self.controller = AppController()
        self.controller._player = self.builtin
        self.controller._state.media_magnet = "magnet:test"
        self.controller._state.position = 10.0
        self.external = RecordingPlayer()
        self.controller._external["vlc"] = self.external

    def tearDown(self) -> None:
        self.controller.shutdown()

    def test_switch_preserves_position_and_play_state(self) -> None:
        for playing in (True, False):
            with self.subTest(playing=playing):
                self.controller._player = self.builtin
                self.controller._state.playing = playing
                self.external.calls.clear()
                self.controller.selectPlayer("vlc")
                self.assertIn(("seek", 42.5), self.external.calls)
                self.assertEqual(self.external.calls[-1], ("play",) if playing else ("pause",))
                self.assertEqual(self.controller.currentPosition(), 42.5)

    def test_selecting_current_player_does_not_reload_media(self) -> None:
        self.controller.selectPlayer("builtin")
        self.assertEqual(self.builtin.calls, [])

    def test_loading_player_keeps_handoff_position(self) -> None:
        self.external.loaded = False
        self.controller.selectPlayer("vlc")
        self.external.position = 0.0
        self.controller._on_local_position(0.0)
        self.controller._refresh_playback()
        self.assertEqual(self.controller.currentPosition(), 42.5)

    def test_player_error_is_reported_once(self) -> None:
        errors: list[str] = []
        self.controller.errorOccurred.connect(errors.append)
        self.controller.selectPlayer("vlc")
        self.external.error = "Control connection failed"
        self.controller._refresh_playback()
        self.controller._refresh_playback()
        self.assertEqual(len(errors), 1)
        self.assertIn("Control connection failed", errors[0])

    def test_unavailable_player_keeps_current_player(self) -> None:
        self.external.is_available = lambda: False
        self.controller.selectPlayer("vlc")
        self.assertIs(self.controller._player, self.builtin)
        self.assertEqual(self.builtin.calls, [])

    def test_synchronous_load_error_is_reported(self) -> None:
        errors: list[str] = []
        self.controller.errorOccurred.connect(errors.append)
        self.external.load = Mock(side_effect=RuntimeError("Executable not found"))
        self.controller.selectPlayer("vlc")
        self.assertEqual(len(errors), 1)
        self.assertIn("Executable not found", errors[0])


@unittest.skipUnless(os.environ.get("WATCHALONG_NATIVE_PLAYERS") == "1", "Native player tests are opt-in")
class NativePlayerTests(unittest.TestCase):
    @staticmethod
    def wait_until(predicate: Callable[[], bool], timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        wakeup = threading.Event()
        while time.monotonic() < deadline:
            if predicate():
                return True
            wakeup.wait(0.05)
        return False

    def exercise_player(self, player: Player) -> None:
        with tempfile.TemporaryDirectory(prefix="watchalong-player-test-") as directory:
            media = Path(directory) / "silence.wav"
            with wave.open(str(media), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(8000)
                audio.writeframes(b"\0\0" * 8000 * 30)
            for cycle in range(2):
                with self.subTest(cycle=cycle):
                    worker = None
                    try:
                        started = time.monotonic()
                        player.load(media.as_uri())
                        worker = player._worker
                        player.pause()
                        player.set_volume(0)
                        self.assertLess(time.monotonic() - started, 0.2)
                        self.assertTrue(self.wait_until(lambda: player.is_loaded() or bool(player.get_error())))
                        self.assertEqual(player.get_error(), "")
                        self.assertTrue(player.is_loaded())
                        started = time.monotonic()
                        player.seek(2.25)
                        player.play()
                        self.assertLess(time.monotonic() - started, 0.2)
                        self.assertTrue(self.wait_until(lambda: player.get_position() >= 2.0))
                        started = time.monotonic()
                        player.pause()
                        player.get_position()
                        player.get_duration()
                        player.shutdown()
                        self.assertLess(time.monotonic() - started, 0.2)
                    finally:
                        player.shutdown()
                        if worker is not None:
                            worker.thread.join(3)
                            self.assertFalse(worker.thread.is_alive())
                            if worker._process is not None:
                                self.assertIsNotNone(worker._process.poll())

    @unittest.skipUnless(MpvExternalPlayer.is_available(), "mpv or its IPC dependency is not installed")
    def test_native_mpv_lifecycle(self) -> None:
        self.exercise_player(MpvExternalPlayer())

    @unittest.skipUnless(VlcExternalPlayer.is_available(), "VLC is not installed")
    def test_native_vlc_lifecycle(self) -> None:
        self.exercise_player(VlcExternalPlayer())


if __name__ == "__main__":
    unittest.main()