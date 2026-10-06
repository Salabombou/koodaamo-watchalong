from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
import wave
from pathlib import Path
from typing import Callable
from unittest.mock import Mock, patch

import requests
from PySide6.QtCore import QCoreApplication, QEventLoop, QTimer
from PySide6.QtGui import QGuiApplication
from PySide6.QtMultimedia import QMediaPlayer, QVideoSink

from watchalong.controller import AppController
from watchalong.players.base import Player, _SeekTracker
from watchalong.players.mpv_external import MpvExternalPlayer, _IpcTransport, _MpvWorker
from watchalong.players.qt_media import QtMediaPlayer
from watchalong.players.vlc_external import VlcExternalPlayer, _find_vlc, _VlcWorker


class RecordingPlayer(Player):
    def __init__(self, position: float = 0.0) -> None:
        super().__init__()
        self.position = position
        self.loaded = True
        self.duration = 0.0
        self.ended = False
        self.native_seek: float | None = None
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
        self.ended = self.duration > 0 and seconds >= self.duration

    def set_volume(self, percent: float) -> None:
        self.calls.append(("volume", percent))

    def get_position(self) -> float:
        return self.position

    def get_duration(self) -> float:
        return self.duration

    def is_at_end(self) -> bool:
        return self.ended

    def take_seek(self) -> float | None:
        position = self.native_seek
        self.native_seek = None
        return position

    def is_loaded(self) -> bool:
        return self.loaded

    def get_error(self) -> str:
        return self.error

    def shutdown(self) -> None:
        self.calls.append(("shutdown",))


class ExternalPlayerTests(unittest.TestCase):
    def test_seek_tracker_ignores_progress_and_our_own_seeks(self) -> None:
        tracker = _SeekTracker()
        with patch("watchalong.players.base.time.monotonic", return_value=10.0) as clock:
            tracker.observe(2.0, True)
            clock.return_value = 10.25
            tracker.observe(2.25, True)
            self.assertIsNone(tracker.take())
            clock.return_value = 12.0
            tracker.observe(2.25, True)
            self.assertIsNone(tracker.take(), "Buffering was mistaken for a native seek")
            tracker.expect(7.5)
            tracker.observe(7.5, False)
            self.assertIsNone(tracker.take())
            tracker.observe(18.5, False)
            self.assertEqual(tracker.take(), 18.5)
            self.assertIsNone(tracker.take())

    def test_mpv_native_seek_events_do_not_echo_commands(self) -> None:
        worker = _MpvWorker("mpv", "test", "test-pipe")
        worker._handle_line(b'{"event":"property-change","name":"time-pos","data":2.25}')
        worker.seeks.expect(7.5)
        worker._handle_line(b'{"event":"seek"}')
        worker._handle_line(b'{"event":"property-change","name":"time-pos","data":7.5}')
        self.assertIsNone(worker.seeks.take())
        worker._handle_line(b'{"event":"seek"}')
        worker._handle_line(b'{"event":"property-change","name":"time-pos","data":7.6}')
        self.assertEqual(worker.seeks.take(), 7.6)

    def test_vlc_native_seek_does_not_echo_http_commands(self) -> None:
        worker = _VlcWorker("vlc", "test")
        response = Mock(ok=True)
        worker._session.get = Mock(return_value=response)
        try:
            for position, params in ((2.25, None), (7.5, {"command": "seek", "val": "7.5"}), (18.5, None)):
                response.json.return_value = {"time": position, "length": 30, "position": position / 30, "state": "paused"}
                worker._status(params)
                self.assertEqual(worker.seeks.take(), 18.5 if position == 18.5 else None)
        finally:
            worker._session.close()

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
        ) as launch:
            try:
                player.load("http://127.0.0.1/video")
                worker = player._worker
                self.assertTrue(write_started.wait(1))
                arguments = launch.call_args.args[0]
                self.assertIn("--idle=yes", arguments)
                self.assertIn("--keep-open=yes", arguments)
                self.assertIn("--keep-open-pause=yes", arguments)
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
                self.assertEqual(commands[4:], [
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
            ) as launch, patch(
                "watchalong.players.vlc_external.requests.Session.get", side_effect=stalled_request
            ):
                started = time.monotonic()
                player.load("http://127.0.0.1/video")
                worker = player._worker
                self.assertTrue(request_started.wait(1), "HTTP worker did not start")
                arguments = launch.call_args.args[0]
                self.assertIn("--play-and-pause", arguments)
                self.assertIn("--no-play-and-exit", arguments)
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
                    {"command": "seek", "val": "12.50000000%"},
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

    def test_qt_eof_retains_loaded_media(self) -> None:
        self.media.mediaStatus.return_value = QMediaPlayer.MediaStatus.EndOfMedia
        self.assertTrue(self.player.is_at_end())
        self.assertTrue(self.player.is_loaded())

    def test_qt_same_url_reload_clears_old_demuxer(self) -> None:
        url = "http://127.0.0.1/video?v=1"
        self.player.load(url)
        self.player.load(url)
        sources = [call.args[0].toString() for call in self.media.setSource.call_args_list]
        self.assertEqual(sources, ["", url, "", url])
        self.assertEqual(self.media.stop.call_count, 2)

    def test_qt_unload_releases_source_without_detaching_video(self) -> None:
        self.player.seek(30)
        self.player.unload()
        self.assertTrue(self.media.setSource.call_args.args[0].isEmpty())
        self.media.setVideoOutput.assert_not_called()
        self.assertIsNone(self.player._pending_seek)


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

    def test_switch_away_from_builtin_unloads_its_source(self) -> None:
        self.builtin.unload = Mock()
        self.controller.selectPlayer("vlc")
        self.builtin.unload.assert_called_once_with()

    def test_loading_player_keeps_handoff_position(self) -> None:
        self.external.loaded = False
        self.controller.selectPlayer("vlc")
        self.assertTrue(self.controller.playerLoading)
        self.external.position = 0.0
        self.controller._on_local_position(0.0)
        self.controller._refresh_playback()
        self.assertEqual(self.controller.currentPosition(), 42.5)
        self.external.loaded = True
        self.controller._refresh_playback()
        self.assertFalse(self.controller.playerLoading)

    def test_player_error_is_reported_once(self) -> None:
        errors: list[str] = []
        self.controller.errorOccurred.connect(errors.append)
        self.controller.selectPlayer("vlc")
        self.external.error = "Control connection failed"
        self.controller._refresh_playback()
        self.controller._refresh_playback()
        self.assertEqual(len(errors), 1)
        self.assertIn("Control connection failed", errors[0])
        self.assertFalse(self.controller.playerLoading)
        self.assertEqual(self.controller.playerError, "Control connection failed")

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
        self.assertFalse(self.controller.playerLoading)


@unittest.skipUnless(os.environ.get("WATCHALONG_NATIVE_PLAYERS") == "1", "Native player tests are opt-in")
class NativePlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.qt_app = QCoreApplication.instance() or QGuiApplication(["native-player-check", "-platform", "offscreen"])

    @staticmethod
    def wait_until(predicate: Callable[[], bool], timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        wakeup = threading.Event()
        while time.monotonic() < deadline:
            if predicate():
                return True
            if QCoreApplication.instance() is not None:
                loop = QEventLoop()
                QTimer.singleShot(50, loop.quit)
                loop.exec()
            else:
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
                        player.pause()
                        self.assertLess(time.monotonic() - started, 0.2)
                        self.assertTrue(self.wait_until(lambda: abs(player.get_position() - 2.25) < 0.08))
                        self.assertIsNone(player.take_seek(), "App seek echoed as a native seek")
                        if player.key == "mpv":
                            transport = _IpcTransport(worker._ipc_path)
                            try:
                                self.assertTrue(transport.connect(worker.stopped, timeout=2))
                                transport.write(b'{"command":["seek",7.5,"absolute","exact"]}\n')
                            finally:
                                transport.close()
                        else:
                            response = requests.get(
                                worker._base + "/status.json",
                                params={"command": "seek", "val": f"{7.5 / player.get_duration() * 100:.8f}%"},
                                auth=("", worker._password), timeout=2,
                            )
                            response.raise_for_status()
                        native_events = []

                        def received_seek():
                            position = player.take_seek()
                            if position is not None:
                                native_events.append(position)
                            return bool(native_events)

                        self.assertTrue(self.wait_until(received_seek), f"{player.key} did not report an external seek")
                        self.assertAlmostEqual(native_events[-1], 7.5, delta=0.08)
                        started = time.monotonic()
                        player.play()
                        self.assertLess(time.monotonic() - started, 0.2)
                        self.assertTrue(self.wait_until(lambda: player.get_position() >= 2.0))
                        player.seek(player.get_duration() - 0.5)
                        player.play()
                        self.assertTrue(self.wait_until(player.is_at_end), f"{player.key} did not retain EOF: {player.get_error()}")
                        self.assertTrue(player.is_loaded())
                        self.assertIsNone(worker._process.poll())
                        player.seek(1.25)
                        player.pause()
                        self.assertTrue(self.wait_until(lambda: abs(player.get_position() - 1.25) < 0.08))
                        self.assertFalse(player.is_at_end())
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

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required to generate the MP4 fixture")
    def test_native_mp4_http_seeks_and_player_roundtrips(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "video.mp4"
            subprocess.run([
                shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-t", "6", "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac", str(path),
            ], check=True, timeout=30, capture_output=True)
            engine = Mock()
            engine.file_size.return_value = path.stat().st_size
            engine.file_path_on_disk.return_value = str(path)
            engine.piece_length.return_value = 65536
            engine.file_offset.return_value = 0
            engine.have_piece.return_value = True
            with patch("watchalong.controller.TorrentEngine", return_value=engine), patch(
                "watchalong.torrent.stream_server.config.STREAM_PORT", 0
            ):
                controller = AppController()
            controller._player = controller._builtin
            controller._player_key = "builtin"
            controller._is_host = True
            controller._state.media_id = "movie"
            controller._state.media_magnet = "magnet:test"
            builtin = controller._builtin
            sink = QVideoSink()
            builtin._player.setVideoSink(sink)
            workers = []
            try:
                controller.setVolume(0)
                controller._load_current_player(0.0)
                self.assertTrue(self.wait_until(lambda: builtin.is_loaded() or bool(builtin.get_error())))
                self.assertEqual(builtin.get_error(), "")
                builtin.play()
                self.assertTrue(self.wait_until(lambda: builtin.get_position() > 0.25 or bool(builtin.get_error())), "HTTP playback never started before seeking")
                builtin.pause()
                for key, factory in (("mpv", MpvExternalPlayer), ("vlc", VlcExternalPlayer)):
                    if not factory.is_available():
                        continue
                    for target in (4.25, 1.25):
                        builtin.seek(target)
                        builtin.play()
                        self.assertTrue(
                            self.wait_until(lambda: builtin.get_position() > target + 0.25 or bool(builtin.get_error())),
                            f"position={builtin.get_position()}, target={target}, status={builtin._player.mediaStatus()}, state={builtin._player.playbackState()}",
                        )
                        builtin.pause()
                        self.assertEqual(builtin.get_error(), "")
                    target = builtin.get_position()
                    controller.selectPlayer(key)
                    external = controller._player
                    workers.append(external._worker)
                    self.assertTrue(self.wait_until(lambda: external.is_loaded() or bool(external.get_error())))
                    self.assertEqual(external.get_error(), "")
                    self.assertTrue(self.wait_until(lambda: abs(external.get_position() - target) < 0.15))
                    controller.selectPlayer("builtin")
                    self.assertTrue(self.wait_until(lambda: builtin.is_loaded() or bool(builtin.get_error())))
                    self.assertEqual(builtin.get_error(), "")
                    self.assertTrue(self.wait_until(lambda: abs(builtin.get_position() - target) < 0.15))
                builtin.seek(builtin.get_duration() - 0.25)
                builtin.play()
                self.assertTrue(self.wait_until(builtin.is_at_end))
                self.assertTrue(builtin.is_loaded())
                builtin.seek(0.5)
                builtin.play()
                self.assertTrue(self.wait_until(lambda: builtin.get_position() > 0.75 or bool(builtin.get_error())))
                self.assertEqual(builtin.get_error(), "")
            finally:
                controller.shutdown()
                controller._stream._thread.join(3)
                self.assertFalse(controller._stream._thread.is_alive())
                for worker in workers:
                    worker.thread.join(3)
                    self.assertFalse(worker.thread.is_alive())


if __name__ == "__main__":
    unittest.main()