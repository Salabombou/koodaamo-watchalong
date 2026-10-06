from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import requests

from watchalong.torrent.stream_server import StreamServer


class StreamServerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "video.mp4"
        self.data = bytes(range(256)) * 1024
        self.path.write_bytes(self.data)
        self.engine = Mock()
        self.engine.file_size.return_value = len(self.data)
        self.engine.file_path_on_disk.return_value = str(self.path)
        self.engine.piece_length.return_value = 16384
        self.engine.file_offset.return_value = 73
        self.engine.have_piece.return_value = True
        self.server = StreamServer(self.engine)
        with patch("watchalong.torrent.stream_server.config.STREAM_PORT", 0):
            self.server.start()
        self.assertIsNotNone(self.server.url)
        self.loop_errors = []
        self.server._loop.call_soon_threadsafe(
            self.server._loop.set_exception_handler, lambda loop, context: self.loop_errors.append(context)
        )

    def tearDown(self) -> None:
        self.engine.have_piece.return_value = True
        self.server.stop()
        self.server._thread.join(3)
        self.assertFalse(self.server._thread.is_alive())
        self.directory.cleanup()
        self.assertFalse(self.loop_errors, self.loop_errors)

    def test_seek_ranges_return_exact_bytes_across_piece_boundaries(self) -> None:
        with requests.Session() as session:
            for start, end in ((0, 8192), (15300, 19000), (250000, len(self.data) - 1), (35, 500)):
                response = session.get(self.server.url, headers={"Range": f"bytes={start}-{end}"}, timeout=2)
                self.assertEqual(response.status_code, 206)
                self.assertEqual(response.headers["Content-Range"], f"bytes {start}-{end}/{len(self.data)}")
                self.assertEqual(response.content, self.data[start:end + 1])

    def test_head_suffix_and_invalid_ranges(self) -> None:
        response = requests.head(self.server.url, timeout=2)
        self.assertEqual(int(response.headers["Content-Length"]), len(self.data))
        response = requests.get(self.server.url, headers={"Range": "bytes=-33"}, timeout=2)
        self.assertEqual(response.content, self.data[-33:])
        response = requests.get(self.server.url, headers={"Range": "bytes=999999-"}, timeout=2)
        self.assertEqual(response.status_code, 416)

    def test_abandoned_seek_cancels_a_range_waiting_for_pieces(self) -> None:
        finished = threading.Event()
        original = self.server._stream_range

        async def watched(*arguments):
            try:
                await original(*arguments)
            finally:
                finished.set()

        self.server._stream_range = watched
        self.engine.have_piece.return_value = False
        response = requests.get(self.server.url, headers={"Range": "bytes=0-8192"}, stream=True, timeout=2)
        response.close()
        self.assertTrue(finished.wait(1), "Disconnected range kept waiting for torrent pieces")


if __name__ == "__main__":
    unittest.main()