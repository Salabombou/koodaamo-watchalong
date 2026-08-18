"""Local HTTP server that streams the active torrent file to a media player.

Players (built-in libmpv, external mpv, or VLC) request byte ranges from this
server. For each range we raise the priority of the covering pieces, wait for
them to arrive, then serve the bytes from disk. This lets playback start before
the whole file has downloaded while keeping the torrent's P2P relay active.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from typing import Optional

from aiohttp import web

from .. import config
from .engine import TorrentEngine

log = logging.getLogger(__name__)

_CHUNK = 64 * 1024


class StreamServer:
    def __init__(self, engine: TorrentEngine) -> None:
        self._engine = engine
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._runner: Optional[web.AppRunner] = None
        self._port: int = 0
        self._ready = threading.Event()

    @property
    def url(self) -> Optional[str]:
        if not self._port:
            return None
        return f"http://{config.STREAM_HOST}:{self._port}/video"

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="stream-server", daemon=True)
        self._thread.start()
        self._ready.wait(timeout=10)

    def stop(self) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._loop.stop)

    # --- server thread -------------------------------------------------------

    def _run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            app = web.Application()
            app.router.add_get("/video", self._handle_video)  # HEAD uses the same handler
            self._runner = web.AppRunner(app)
            self._loop.run_until_complete(self._runner.setup())
            site = web.TCPSite(self._runner, config.STREAM_HOST, config.STREAM_PORT)
            self._loop.run_until_complete(site.start())
            self._port = site._server.sockets[0].getsockname()[1]
            log.info("Stream server listening on %s", self.url)
        except Exception:
            log.exception("Stream server failed to start")
            self._ready.set()
            return
        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            self._loop.run_until_complete(self._runner.cleanup())
            self._loop.close()

    # --- request handlers ----------------------------------------------------

    def _base_headers(self, size: int) -> dict[str, str]:
        return {
            "Accept-Ranges": "bytes",
            "Content-Type": "video/x-matroska"
            if (self._engine.file_path_on_disk() or "").lower().endswith(".mkv")
            else "video/mp4",
            "Cache-Control": "no-cache",
        }

    async def _handle_video(self, request: web.Request) -> web.StreamResponse:
        size = await self._await_size()
        if size is None:
            return web.Response(status=503, text="No media")

        if request.method == "HEAD":
            headers = self._base_headers(size)
            headers["Content-Length"] = str(size)
            return web.Response(status=200, headers=headers)

        start, end = self._parse_range(request.headers.get("Range"), size)
        if start is None:
            return web.Response(
                status=416,
                headers={"Content-Range": f"bytes */{size}"},
            )

        is_partial = request.headers.get("Range") is not None
        headers = self._base_headers(size)
        headers["Content-Length"] = str(end - start + 1)
        if is_partial:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"

        response = web.StreamResponse(status=206 if is_partial else 200, headers=headers)
        await response.prepare(request)

        try:
            await self._stream_range(response, start, end)
        except (ConnectionError, asyncio.CancelledError):
            # Seeking/closing drops the current range request and opens a new
            # one; the broken write is expected, not an error.
            log.debug("Client disconnected during stream")
        except Exception:  # pragma: no cover
            log.exception("Error while streaming range")
        return response

    # --- streaming core ------------------------------------------------------

    async def _stream_range(self, response: web.StreamResponse, start: int, end: int) -> None:
        piece_length = self._engine.piece_length()
        file_offset = self._engine.file_offset()
        if piece_length is None or file_offset is None:
            return

        path = await self._await_file_path()
        if path is None:
            return

        pos = start
        with open(path, "rb", buffering=0) as handle:
            while pos <= end:
                global_offset = file_offset + pos
                piece = global_offset // piece_length

                self._engine.prioritize_from(piece)
                while not self._engine.have_piece(piece):
                    await asyncio.sleep(0.1)

                # Do not read past the current piece boundary (next piece may
                # not be downloaded yet), the requested end, or one chunk.
                piece_end_global = (piece + 1) * piece_length - 1
                piece_end_local = piece_end_global - file_offset
                to_read = min(_CHUNK, end - pos + 1, piece_end_local - pos + 1)
                if to_read <= 0:
                    break

                handle.seek(pos)
                data = handle.read(to_read)
                if not data:
                    await asyncio.sleep(0.1)
                    continue
                await response.write(data)
                pos += len(data)
        await response.write_eof()

    # --- waiting helpers -----------------------------------------------------

    async def _await_size(self, timeout: float = 30.0) -> Optional[int]:
        elapsed = 0.0
        while elapsed < timeout:
            size = self._engine.file_size()
            if size:
                return size
            await asyncio.sleep(0.25)
            elapsed += 0.25
        return None

    async def _await_file_path(self, timeout: float = 30.0) -> Optional[str]:
        elapsed = 0.0
        while elapsed < timeout:
            path = self._engine.file_path_on_disk()
            if path and os.path.exists(path):
                return path
            await asyncio.sleep(0.25)
            elapsed += 0.25
        return None

    @staticmethod
    def _parse_range(header: Optional[str], size: int) -> tuple[Optional[int], Optional[int]]:
        if not header:
            return 0, size - 1
        if not header.startswith("bytes="):
            return None, None
        spec = header[len("bytes="):].split(",")[0].strip()
        start_s, _, end_s = spec.partition("-")
        try:
            if start_s == "":  # suffix range: bytes=-N
                length = int(end_s)
                if length <= 0:
                    return None, None
                start = max(0, size - length)
                return start, size - 1
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        except ValueError:
            return None, None
        end = min(end, size - 1)
        if start > end or start >= size:
            return None, None
        return start, end
