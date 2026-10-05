from __future__ import annotations

import base64
import io
import multiprocessing
import queue
import random
import re
import threading
import time
from multiprocessing.connection import Connection
from pathlib import Path

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError
from PySide6.QtCore import QObject, Property, Qt, Signal, Slot
from materialyoucolor.contrast.contrast import Contrast
from materialyoucolor.dynamiccolor.material_dynamic_colors import MaterialDynamicColors
from materialyoucolor.hct.hct import Hct
from materialyoucolor.palettes.tonal_palette import TonalPalette
from materialyoucolor.quantize import QuantizeCelebi
from materialyoucolor.scheme.scheme_expressive import SchemeExpressive
from materialyoucolor.scheme.scheme_monochrome import SchemeMonochrome
from materialyoucolor.scheme.scheme_neutral import SchemeNeutral
from materialyoucolor.scheme.scheme_tonal_spot import SchemeTonalSpot
from materialyoucolor.scheme.scheme_vibrant import SchemeVibrant
from materialyoucolor.score.score import Score, ScoreOptions

from . import themes
from .settings import local_path

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
STYLES = {
    "balanced": SchemeTonalSpot,
    "vivid": SchemeVibrant,
    "expressive": SchemeExpressive,
    "muted": SchemeNeutral,
}
SURFACES = ("background", "surface", "surfaceElevated", "surfaceHover")


def opaque_hex(argb: int) -> str:
    return f"#{argb & 0xFFFFFF:06X}"


def color_argb(color: str) -> int:
    if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise ValueError("Choose a color in #RRGGBB format")
    try:
        return 0xFF000000 | int(color[1:], 16)
    except ValueError as exc:
        raise ValueError("Choose a color in #RRGGBB format") from exc


def contrast_ratio(first: str, second: str) -> float:
    return Contrast.ratio_of_tones(
        Hct.from_int(color_argb(first)).tone, Hct.from_int(color_argb(second)).tone
    )


def _readable_tone(palette: TonalPalette, tone: float, backgrounds: list[str], ratio: float, dark: bool) -> str:
    direction = 1 if dark else -1
    for offset in range(101):
        candidate = opaque_hex(palette.tone(max(0, min(100, tone + direction * offset))))
        if all(contrast_ratio(candidate, background) >= ratio for background in backgrounds):
            return candidate
    raise ValueError("Unable to generate readable colors")


def generate_theme(seed: str, dark: bool, style: str = "balanced") -> dict:
    if style not in STYLES:
        raise ValueError("Unknown palette style")
    source = color_argb(seed)
    channels = [(source >> shift) & 255 for shift in (16, 8, 0)]
    scheme_type = SchemeMonochrome if max(channels) - min(channels) <= 5 else STYLES[style]
    scheme = scheme_type(Hct.from_int(source), dark, 0.0, spec_version="2021")
    roles = MaterialDynamicColors(spec="2021")
    mapping = {
        "background": "background", "surface": "surfaceContainerLow",
        "surfaceElevated": "surfaceContainerHigh", "surfaceHover": "surfaceContainerHighest",
        "border": "outline", "accent": "primary", "accentText": "onPrimary",
        "text": "onSurface", "subtext": "onSurfaceVariant", "danger": "error",
    }
    colors = {token: opaque_hex(getattr(roles, role).get_argb(scheme)) for token, role in mapping.items()}
    tone = Hct.from_int(color_argb(colors["accent"])).tone
    hover = tone + (6 if dark and tone < 94 else -6 if dark else -5 if tone > 5 else 6)
    pressed = tone + (-8 if dark else -10 if tone > 10 else 12)
    foreground = [colors["accentText"]]
    colors["accentHover"] = _readable_tone(scheme.primary_palette, hover, foreground, 4.5, dark)
    colors["accentPressed"] = _readable_tone(scheme.primary_palette, pressed, foreground, 4.5, dark)
    backgrounds = [colors[token] for token in SURFACES]
    colors["faint"] = _readable_tone(scheme.neutral_variant_palette, 70 if dark else 35, backgrounds, 4.5, dark)
    for token, source_color in (("success", 0xFF187846), ("warning", 0xFF80600B)):
        colors[token] = _readable_tone(TonalPalette.from_int(source_color), 80 if dark else 35, backgrounds, 4.5, dark)
    colors["overlayScrim"] = themes.DARK["overlayScrim"] if dark else themes.LIGHT["overlayScrim"]
    return themes.validate_theme({"format": themes.FORMAT, "version": 1, "name": "My theme", "isDark": dark, "colors": colors})


def generate_candidate(seed: str, style: str = "balanced", population: int = 0) -> dict:
    return {"seed": opaque_hex(color_argb(seed)), "population": population,
            "dark": generate_theme(seed, True, style), "light": generate_theme(seed, False, style)}


def generate_random(style: str = "balanced", seed: int | None = None) -> dict:
    generator = random.Random(seed)
    candidates = []
    used = set()
    while len(candidates) < 6:
        color = opaque_hex(Hct.from_hct(generator.uniform(0, 360), generator.uniform(36, 72), generator.uniform(45, 65)).to_int())
        if color not in used:
            candidates.append(generate_candidate(color, style))
            used.add(color)
    return {"candidates": candidates, "thumbnail": ""}


def generate_image(path: str, style: str = "balanced") -> dict:
    source = Path(path)
    if source.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("Choose an image smaller than 20 MiB")
    try:
        with Image.open(source, formats=["PNG", "JPEG", "WEBP", "BMP", "GIF"]) as opened:
            if opened.width * opened.height > MAX_IMAGE_PIXELS:
                raise ValueError("Choose an image with fewer than 24 million pixels")
            opened.thumbnail((256, 256))
            image = ImageOps.exif_transpose(opened)
            profile = image.info.get("icc_profile")
            if profile and image.mode in ("RGB", "RGBA", "CMYK"):
                image = ImageCms.profileToProfile(image, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                                                 ImageCms.createProfile("sRGB"), outputMode="RGBA")
            image = image.convert("RGBA")
            preview = io.BytesIO()
            image.save(preview, format="PNG")
            image.thumbnail((128, 128))
            pixels = image.get_flattened_data() if hasattr(image, "get_flattened_data") else image.getdata()
            samples = [pixel[:3] for pixel in pixels if pixel[3] >= 128]
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, ImageCms.PyCMSError) as exc:
        raise ValueError("Unable to read this image; choose a valid PNG, JPEG, WebP, BMP, or GIF") from exc
    if not samples:
        raise ValueError("This image has no visible colors")
    populations = QuantizeCelebi(samples, 32)
    fallback = max(populations, key=populations.get)
    ranked = Score.score(populations, ScoreOptions(desired=6, fallback_color_argb=fallback))
    seeds = list(dict.fromkeys([*ranked, *sorted(populations, key=populations.get, reverse=True)]))[:6]
    return {"candidates": [generate_candidate(opaque_hex(color), style, populations.get(color, 0)) for color in seeds],
            "thumbnail": "data:image/png;base64," + base64.b64encode(preview.getvalue()).decode("ascii")}


def _generate_payload(payload: dict) -> dict:
    style = payload["style"]
    if payload["kind"] == "image":
        return generate_image(payload["path"], style)
    if payload["kind"] == "random":
        return generate_random(style)
    if payload["kind"] == "color":
        return {"candidates": [generate_candidate(payload["color"], style)], "thumbnail": ""}
    return {"candidates": [generate_candidate(entry["seed"], style, entry.get("population", 0))
                           for entry in payload["seeds"]], "thumbnail": ""}


def _generation_process(payload: dict, output: Connection) -> None:
    try:
        output.send((True, _generate_payload(payload)))
    except Exception as exc:
        output.send((False, str(exc)))
    finally:
        output.close()


def _generate_isolated(payload: dict, stopped: threading.Event, timeout: float = 30.0) -> dict | None:
    if stopped.is_set():
        return None
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_generation_process, args=(payload, sender), daemon=True)
    deadline = time.monotonic() + timeout
    try:
        process.start()
        sender.close()
        while not stopped.is_set():
            if receiver.poll(0.05):
                try:
                    success, result = receiver.recv()
                except EOFError as exc:
                    raise RuntimeError("Palette generation stopped unexpectedly") from exc
                if not success:
                    raise ValueError(result)
                return result
            if not process.is_alive():
                raise RuntimeError("Palette generation stopped unexpectedly")
            if time.monotonic() >= deadline:
                raise TimeoutError("Palette generation took too long; try a smaller image")
        return None
    finally:
        if process.pid is not None:
            process.join(0.2)
            if process.is_alive():
                process.terminate()
                process.join(1)
            if process.is_alive():
                process.kill()
                process.join()
            process.close()
        receiver.close()
        sender.close()


class ThemeGenerationController(QObject):
    changed = Signal()
    resultReady = Signal("QVariantMap")
    _completed = Signal(int, object, str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._busy = False
        self._error = ""
        self._request_id = 0
        self._cancelled = threading.Event()
        self._closed = False
        self._jobs: queue.Queue = queue.Queue(maxsize=1)
        self._thread = threading.Thread(target=self._supervise, name="theme-generation", daemon=True)
        self._completed.connect(self._deliver, Qt.ConnectionType.QueuedConnection)
        self._thread.start()

    @Property(bool, notify=changed)
    def busy(self) -> bool:
        return self._busy

    @Property(str, notify=changed)
    def errorMessage(self) -> str:
        return self._error

    def _discard_pending(self) -> None:
        try:
            self._jobs.get_nowait()
        except queue.Empty:
            pass

    def _request(self, payload: dict) -> None:
        if self._closed:
            return
        self._cancelled.set()
        self._request_id += 1
        self._cancelled = threading.Event()
        self._discard_pending()
        self._busy = True
        self._error = ""
        self._jobs.put_nowait((self._request_id, payload, self._cancelled))
        self.changed.emit()

    @Slot(str, str)
    def requestImage(self, path: str, style: str) -> None:
        self._request({"kind": "image", "path": str(local_path(path)), "style": style})

    @Slot(str)
    def requestRandom(self, style: str) -> None:
        self._request({"kind": "random", "style": style})

    @Slot(str, str)
    def requestColor(self, color: str, style: str) -> None:
        self._request({"kind": "color", "color": color, "style": style})

    @Slot("QVariantList", str)
    def requestSeeds(self, seeds: list, style: str) -> None:
        self._request({"kind": "seeds", "seeds": [{"seed": entry["seed"], "population": entry.get("population", 0)}
                                                  for entry in seeds[:6]], "style": style})

    @Slot()
    def cancel(self) -> None:
        self._cancelled.set()
        self._request_id += 1
        self._discard_pending()
        self._busy = False
        self._error = ""
        self.changed.emit()

    def _supervise(self) -> None:
        while True:
            job = self._jobs.get()
            if job is None:
                return
            request_id, payload, stopped = job
            try:
                result = _generate_isolated(payload, stopped)
                if result is not None and not self._closed:
                    self._completed.emit(request_id, result, "")
            except Exception as exc:
                if not self._closed:
                    self._completed.emit(request_id, None, str(exc))

    @Slot(int, object, str)
    def _deliver(self, request_id: int, result: dict | None, error: str) -> None:
        if self._closed or request_id != self._request_id:
            return
        self._busy = False
        self._error = error
        self.changed.emit()
        if result is not None:
            self.resultReady.emit(result)

    @Slot()
    def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.cancel()
        self._jobs.put_nowait(None)

    def wait_for_shutdown(self) -> None:
        self._thread.join(3)