from __future__ import annotations

import time
import tempfile
import threading
from pathlib import Path
import unittest
from collections import deque
from copy import deepcopy
from unittest.mock import Mock, patch

from PySide6.QtCore import QCoreApplication

from test_external_players import RecordingPlayer
from watchalong.controller import AppController

from watchalong.room import protocol
from watchalong.room.clock import ClockSync
from watchalong.room.roster import Roster


class RoomPrimitiveTests(unittest.TestCase):
    def test_clock_offset_uses_lowest_latency_sample(self) -> None:
        clock = ClockSync()
        self.assertTrue(clock.sample(100, 105.05, 105.06, 100.11))
        self.assertAlmostEqual(clock.offset, 5.0)
        clock.sample(200, 205.8, 205.9, 201.1)
        self.assertAlmostEqual(clock.to_host(300), 305)
        self.assertAlmostEqual(clock.to_local(305), 300)

    def test_clock_rejects_invalid_samples(self) -> None:
        clock = ClockSync()
        self.assertFalse(clock.sample(100, 105, 105, 99))
        self.assertFalse(clock.sample(100, float("nan"), 105, 101))
        self.assertFalse(clock.valid)

    def test_initial_unloaded_members_block_autostart(self) -> None:
        roster = Roster()
        roster.announce("host", "Host", 0)
        roster.update("host", True, True, 1, 1, "Host")
        roster.announce("guest", "Guest", 1)
        self.assertFalse(roster.all_ready)
        roster.update("guest", True, True, 1, 2, "Guest")
        self.assertTrue(roster.all_ready)

    def test_late_joiner_does_not_block_and_auto_readies(self) -> None:
        roster = Roster()
        roster.announce("host", "Host", 0)
        roster.update("host", True, True, 1, 1, "Host")
        roster.announce("guest", "Guest", 1, late=True)
        self.assertTrue(roster.all_ready)
        roster.update("guest", False, True, 1, 2, "Guest")
        self.assertTrue(roster.members["guest"].ready)
        roster.update("guest", False, True, 2, 3, "Guest")
        self.assertFalse(roster.all_ready)

    def test_ignored_spam_cannot_change_readiness_gate(self) -> None:
        roster = Roster()
        roster.announce("host", "Host", 0)
        roster.update("host", True, True, 1, 1, "Host")
        guest = roster.announce("guest", "Guest", 1)
        guest.ignored = True
        for sequence in range(10):
            roster.update("guest", sequence % 2 == 0, True, sequence, 2, "Guest")
            self.assertTrue(roster.all_ready)

    def test_stale_member_updates_and_banned_ids_are_rejected(self) -> None:
        roster = Roster()
        roster.announce("guest", "Guest", 0)
        roster.update("guest", True, True, 3, 1, "Guest")
        roster.update("guest", False, True, 2, 2, "Guest")
        self.assertTrue(roster.members["guest"].ready)
        roster.bans.add("guest")
        self.assertIsNone(roster.announce("guest", "Guest", 3, "new-instance"))

    def test_state_and_message_validation_reject_nonfinite_and_wrong_types(self) -> None:
        self.assertFalse(protocol.validate(protocol.make(protocol.SEEK, "guest", position=float("nan"))))
        self.assertFalse(protocol.validate(protocol.make(protocol.MEMBER, "guest", ready="false")))
        state = protocol.RoomState(host_id="host", session="room")
        self.assertEqual(protocol.RoomState.from_dict(state.to_dict()).phase, "paused")
        broken = state.to_dict()
        broken["position"] = float("inf")
        with self.assertRaises(ValueError):
            protocol.RoomState.from_dict(broken)


class RoomBus:
    def __init__(self) -> None:
        self.controllers: list[AppController] = []
        self.messages: deque[dict] = deque()
        self.drop: set[str] = set()

    def attach(self, controller: AppController) -> None:
        channel = Mock()
        channel.publish.side_effect = lambda message: self.messages.append(deepcopy(message))
        controller._channel = channel
        controller._connected = True
        self.controllers.append(controller)

    def flush(self) -> None:
        count = 0
        while self.messages:
            message = self.messages.popleft()
            if message["t"] in self.drop:
                continue
            for controller in self.controllers:
                if controller._connected:
                    controller._on_message(deepcopy(message))
            count += 1
            if count > 1000:
                raise AssertionError("Room messages did not settle")


class RoomFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.qt_app = QCoreApplication.instance() or QCoreApplication([])

    def controller(self, peer_id: str) -> AppController:
        player = RecordingPlayer(42.5)
        with patch("watchalong.controller.TorrentEngine") as torrent, patch(
            "watchalong.controller.StreamServer"
        ) as stream, patch("watchalong.controller.QtMediaPlayer", return_value=player):
            torrent.return_value.torrent_file_b64.return_value = "metadata"
            torrent.return_value.has_metadata.return_value = True
            stream.return_value.url = "http://127.0.0.1/video"
            controller = AppController()
        controller._self_id = peer_id
        controller._player = player
        self.bus.attach(controller)
        return controller

    def setUp(self) -> None:
        self.bus = RoomBus()
        self.host = self.controller("host")
        self.host._is_host = True
        self.host._state = protocol.RoomState(host_id="host", session="session", media_id="movie",
                                              media_magnet="magnet:test", position=42.5)
        self.host._send_member()
        self.guest = self.controller("guest")
        self.guest._publish(protocol.HELLO, username="Guest", instance=self.guest._instance)
        self.bus.flush()

    def tearDown(self) -> None:
        for controller in self.bus.controllers:
            controller.shutdown()

    def ready_everyone(self) -> None:
        self.host.toggleReady()
        self.guest.toggleReady()
        self.bus.flush()

    def test_preparation_is_nonblocking_and_applies_on_gui_thread(self) -> None:
        from PySide6.QtCore import QEventLoop, QTimer
        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        main_thread = threading.get_ident()
        worker_threads = []
        loop = QEventLoop()
        timeout = QTimer()
        timeout.setSingleShot(True)
        timeout.timeout.connect(loop.quit)
        self.host._seed_finished.connect(loop.quit)

        def prepare(path, stopped):
            worker_threads.append(threading.get_ident())
            started.set()
            release.wait(2)
            finished.set()
            return b"prepared metadata"

        self.host._engine.seed_prepared.return_value = "magnet:prepared"
        with tempfile.TemporaryDirectory() as directory, patch(
            "watchalong.controller.prepare_file_isolated", side_effect=prepare
        ):
            path = Path(directory) / "video.mp4"
            path.touch()
            before = time.monotonic()
            self.host.shareFile(str(path))
            self.assertLess(time.monotonic() - before, 0.2)
            self.assertTrue(started.wait(1))
            self.assertTrue(self.host.mediaPreparing)
            self.assertTrue(self.host.playerLoading)
            self.assertFalse(self.host.canReady)
            self.host._engine.seed_prepared.assert_not_called()
            release.set()
            self.assertTrue(finished.wait(1))
            timeout.start(1000)
            loop.exec()
            timeout.stop()
            self.host._engine.seed_prepared.assert_called_once_with(str(path), b"prepared metadata")
            self.assertFalse(self.host.mediaPreparing)
            self.assertNotEqual(worker_threads, [main_thread])

    def test_preparation_finished_after_leave_is_discarded(self) -> None:
        token = self.host._preparation
        self.host._media_preparing = True
        self.host.leave()
        self.host._on_seed_finished(token, "old.mp4", b"old metadata", "")
        self.host._engine.seed_prepared.assert_not_called()
        self.assertFalse(self.host.mediaPreparing)

    def test_host_transfer_waits_for_video_preparation(self) -> None:
        self.host._media_preparing = True
        self.host.transferHost("guest")
        self.assertFalse(self.host.transferring)
        self.assertTrue(self.host.isHost)

    def test_real_torrent_metadata_can_be_prepared_without_a_session(self) -> None:
        import libtorrent as lt
        from watchalong.torrent.engine import TorrentEngine
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "video.mp4"
            path.write_bytes(b"video data" * 20000)
            metadata = TorrentEngine.prepare_file(str(path))
            info = lt.torrent_info(lt.bdecode(metadata))
            self.assertEqual(info.name(), path.name)
            self.assertEqual(info.total_size(), path.stat().st_size)

    def test_isolated_preparation_returns_real_metadata_and_respects_cancellation(self) -> None:
        import libtorrent as lt
        from watchalong.torrent.engine import prepare_file_isolated
        stopped = threading.Event()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "video.mp4"
            path.write_bytes(b"video data" * 20000)
            metadata = prepare_file_isolated(str(path), stopped)
            self.assertEqual(lt.torrent_info(lt.bdecode(metadata)).total_size(), path.stat().st_size)
            stopped.set()
            self.assertEqual(prepare_file_isolated(str(path), stopped), b"")

    def begin_playback(self) -> None:
        self.ready_everyone()
        self.host._deadline = time.monotonic() - 1
        self.host._finish_countdown()
        self.bus.flush()

    def test_all_ready_schedules_one_shared_three_second_deadline(self) -> None:
        self.ready_everyone()
        self.assertEqual(self.host.phase, "countdown")
        self.assertEqual(self.guest.phase, "countdown")
        self.assertAlmostEqual(self.host._state.start_at, self.guest._state.start_at)
        self.assertGreater(self.host.countdownRemaining, 2.5)
        self.assertLess(abs(self.host.countdownRemaining - self.guest.countdownRemaining), 0.1)
        self.assertFalse(self.host.playing)

    def test_unready_during_countdown_cancels_every_timer(self) -> None:
        self.ready_everyone()
        self.guest.toggleReady()
        self.bus.flush()
        self.assertEqual(self.host.phase, "paused")
        self.assertEqual(self.guest.phase, "paused")
        self.assertFalse(self.guest._start_timer.isActive())
        self.assertEqual(self.guest.countdownRemaining, 0)

    def test_unready_while_playing_pauses_and_seeks_everyone_to_host(self) -> None:
        self.begin_playback()
        self.host._player.position = 67.125
        self.guest._player.position = 65
        self.guest.toggleReady()
        self.bus.flush()
        self.assertFalse(self.host.playing)
        self.assertFalse(self.guest.playing)
        self.assertEqual(self.guest.currentPosition(), 67.125)
        self.assertEqual(self.host._state.position, 67.125)

    def test_late_joiner_catches_up_without_pausing_others(self) -> None:
        self.begin_playback()
        late = self.controller("late")
        late._publish(protocol.HELLO, username="Late", instance=late._instance)
        self.bus.flush()
        self.assertTrue(self.host.playing)
        self.assertTrue(late.playing)
        self.assertTrue(late.selfReady)
        self.assertTrue(self.host._roster.members["late"].ready)

    def test_ignored_spam_and_seek_requests_do_not_pause_host(self) -> None:
        self.begin_playback()
        self.host.setIgnored("guest", True)
        self.bus.flush()
        for sequence in range(50, 60):
            self.guest._publish(protocol.MEMBER, ready=sequence % 2 == 0, loaded=True,
                seq=sequence, instance=self.guest._instance, media_id="movie")
        self.guest._publish(protocol.SEEK, position=1, seq=100)
        self.bus.flush()
        self.assertTrue(self.host.playing)
        self.assertTrue(self.guest.selfIgnored)

    def test_guest_cannot_forge_authoritative_playback(self) -> None:
        self.begin_playback()
        forged = self.host._state.to_dict()
        forged.update(phase="paused", position=1, revision=999)
        self.host._on_message(protocol.make(protocol.STATE, "guest", **forged))
        self.guest._on_message(protocol.make(protocol.STATE, "attacker", **forged))
        self.assertTrue(self.host.playing)
        self.assertTrue(self.guest.playing)

    def test_stale_state_does_not_rewind_playback(self) -> None:
        self.begin_playback()
        stale = self.host._state.to_dict()
        stale.update(phase="paused", position=1, revision=0, members=self.host._roster.records("host"))
        self.guest._on_message(protocol.make(protocol.STATE, "host", **stale))
        self.assertTrue(self.guest.playing)

    def test_kick_disconnects_and_bans_rejoining_identity(self) -> None:
        self.host.kick("guest")
        self.bus.flush()
        self.assertFalse(self.guest.connected)
        self.assertIn("guest", self.host._roster.bans)
        replacement = self.controller("guest")
        replacement._publish(protocol.HELLO, username="Guest", instance=replacement._instance)
        self.bus.flush()
        self.assertFalse(replacement.connected)

    def test_host_transfer_keeps_state_and_bans(self) -> None:
        self.ready_everyone()
        self.host._roster.bans.add("banned")
        self.host.transferHost("guest")
        self.bus.flush()
        self.assertFalse(self.host.isHost)
        self.assertTrue(self.guest.isHost)
        self.assertEqual(self.host._state.host_id, "guest")
        self.assertEqual(self.guest._state.media_magnet, "magnet:test")
        self.assertIn("banned", self.guest._roster.bans)
        self.assertFalse(self.host.transferring)

    def test_transfer_acknowledgement_is_retried_on_heartbeat(self) -> None:
        self.ready_everyone()
        self.bus.drop.add(protocol.HOST_CLAIM)
        self.host.transferHost("guest")
        self.bus.flush()
        self.assertTrue(self.host.transferring)
        self.bus.drop.clear()
        self.guest._send_heartbeat()
        self.bus.flush()
        self.assertFalse(self.host.isHost)
        self.assertFalse(self.host.transferring)

    def test_allowed_seek_pauses_then_schedules_new_countdown(self) -> None:
        self.begin_playback()
        self.host.setOptions(False, True)
        self.bus.flush()
        self.guest.seekTo(18.5)
        self.bus.flush()
        self.assertEqual(self.host.phase, "countdown")
        self.assertEqual(self.guest.currentPosition(), 18.5)

    def test_eof_retains_media_and_stops_until_everyone_readies_again(self) -> None:
        self.begin_playback()
        for controller in (self.host, self.guest):
            controller._player.duration = 60.0
        self.host._player.position = 60.0
        self.host._player.ended = True
        self.host._refresh_playback()
        self.bus.flush()
        for controller in (self.host, self.guest):
            self.assertEqual(controller.phase, "paused")
            self.assertFalse(controller.selfReady)
            self.assertTrue(controller.hasMedia)
            self.assertTrue(controller._player.is_loaded())
            self.assertEqual(controller.currentPosition(), 60.0)
            self.assertFalse(controller._start_timer.isActive())
        self.host._send_heartbeat()
        self.bus.flush()
        self.assertEqual(self.host.phase, "paused")
        self.ready_everyone()
        for controller in (self.host, self.guest):
            self.assertEqual(controller.phase, "countdown")
            self.assertEqual(controller.currentPosition(), 0.0)

    def test_seeking_to_eof_does_not_restart_a_finished_countdown(self) -> None:
        self.begin_playback()
        self.host._player.duration = 60.0
        self.host.seekTo(60.0)
        self.bus.flush()
        self.assertEqual(self.host.phase, "paused")
        self.assertFalse(self.host.selfReady)
        self.assertFalse(self.host._start_timer.isActive())

    def test_native_host_seek_schedules_the_shared_countdown(self) -> None:
        self.begin_playback()
        self.host._player.native_seek = 18.5
        self.host._player.position = 18.5
        self.host._refresh_playback()
        self.bus.flush()
        self.assertEqual(self.host.phase, "countdown")
        self.assertEqual(self.guest.phase, "countdown")
        self.assertEqual(self.guest.currentPosition(), 18.5)
        self.assertEqual(self.host._state.start_at, self.guest._state.start_at)

    def test_allowed_native_guest_seek_schedules_the_shared_countdown(self) -> None:
        self.begin_playback()
        self.host.setOptions(False, True)
        self.bus.flush()
        self.guest._player.native_seek = 18.5
        self.guest._player.position = 18.5
        self.guest._refresh_playback()
        self.bus.flush()
        self.assertEqual(self.host.phase, "countdown")
        self.assertEqual(self.guest.phase, "countdown")
        self.assertEqual(self.host.currentPosition(), 18.5)

    def test_forbidden_native_seek_restores_the_authoritative_timeline(self) -> None:
        self.begin_playback()
        self.guest._player.native_seek = 18.5
        self.guest._player.position = 18.5
        self.guest._refresh_playback()
        self.bus.flush()
        self.assertTrue(self.host.playing)
        self.assertTrue(self.guest.playing)
        self.assertGreater(self.guest.currentPosition(), 42.0)


if __name__ == "__main__":
    unittest.main()