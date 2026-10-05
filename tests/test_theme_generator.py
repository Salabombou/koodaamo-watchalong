from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from PySide6.QtCore import QCoreApplication, QEventLoop, QTimer

from watchalong import themes
from watchalong.theme_generator import STYLES, SURFACES, ThemeGenerationController, _generate_isolated, color_argb, contrast_ratio, generate_image, generate_random, generate_theme, opaque_hex


class ThemeGeneratorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "image.png"

    def test_all_styles_generate_complete_readable_themes(self) -> None:
        for seed in ("#237A64", "#FF3300", "#5533FF", "#FFDD00", "#000000", "#FFFFFF", "#888888"):
            for style in STYLES:
                for dark in (False, True):
                    with self.subTest(seed=seed, style=style, dark=dark):
                        document = generate_theme(seed, dark, style)
                        colors = document["colors"]
                        self.assertEqual(themes.validate_theme(document), document)
                        self.assertEqual(set(colors), set(themes.DARK))
                        self.assertEqual(themes.contrast_warnings(colors), [])
                        for foreground in ("text", "subtext", "faint", "danger", "success", "warning"):
                            for background in SURFACES:
                                self.assertGreaterEqual(contrast_ratio(colors[foreground], colors[background]), 4.5)
                        for background in ("accent", "accentHover", "accentPressed"):
                            self.assertGreaterEqual(contrast_ratio(colors["accentText"], colors[background]), 4.5)

    def test_argb_conversion_and_invalid_colors(self) -> None:
        self.assertEqual(opaque_hex(0x80123456), "#123456")
        self.assertEqual(color_argb("#123456"), 0xFF123456)
        for color in ("red", "#11223344", "#QQQQQQ", "#+12345", "#-12345", None):
            with self.assertRaises(ValueError):
                color_argb(color)
        with self.assertRaises(ValueError):
            generate_theme("#123456", True, "unknown")

    def test_random_is_fresh_and_reproducible(self) -> None:
        first = generate_random(seed=123)
        self.assertEqual(first, generate_random(seed=123))
        self.assertNotEqual(first, generate_random(seed=456))
        self.assertEqual(len({entry["seed"] for entry in first["candidates"]}), 6)
        self.assertEqual(first["thumbnail"], "")

    def test_image_extracts_actual_colors_and_thumbnail(self) -> None:
        image = Image.new("RGB", (100, 100), "#FF0000")
        image.paste("#00FF00", (0, 0, 40, 100))
        image.save(self.path)
        result = generate_image(str(self.path))
        self.assertEqual({entry["seed"] for entry in result["candidates"]}, {"#FF0000", "#00FF00"})
        self.assertEqual(sum(entry["population"] for entry in result["candidates"]), 10000)
        self.assertTrue(result["thumbnail"].startswith("data:image/png;base64,"))

    def test_grayscale_does_not_fall_back_to_blue(self) -> None:
        Image.new("L", (30, 30), 128).save(self.path)
        result = generate_image(str(self.path))
        self.assertEqual(result["candidates"][0]["seed"], "#808080")
        for mode in ("dark", "light"):
            colors = result["candidates"][0][mode]["colors"]
            for token in ("background", "surface", "accent", "text"):
                self.assertEqual(len({colors[token][offset:offset + 2] for offset in (1, 3, 5)}), 1)

    def test_transparent_pixels_do_not_pollute_palette(self) -> None:
        image = Image.new("RGBA", (30, 30), (0, 0, 255, 0))
        image.paste((255, 0, 0, 255), (0, 0, 10, 30))
        image.save(self.path)
        self.assertEqual([entry["seed"] for entry in generate_image(str(self.path))["candidates"]], ["#FF0000"])
        Image.new("RGBA", (20, 20), (255, 0, 0, 0)).save(self.path)
        with self.assertRaisesRegex(ValueError, "no visible colors"):
            generate_image(str(self.path))

    def test_paletted_cmyk_and_animated_images(self) -> None:
        Image.new("P", (30, 30)).save(self.path)
        self.assertTrue(generate_image(str(self.path))["candidates"])
        cmyk = self.path.with_suffix(".jpg")
        Image.new("CMYK", (30, 30), (0, 128, 128, 0)).save(cmyk)
        self.assertTrue(generate_image(str(cmyk))["candidates"])
        animated = self.path.with_suffix(".gif")
        Image.new("RGB", (20, 20), "red").save(animated, save_all=True, append_images=[Image.new("RGB", (20, 20), "blue")])
        self.assertEqual(generate_image(str(animated))["candidates"][0]["seed"], "#FF0000")

    def test_corrupt_oversized_and_unsupported_images(self) -> None:
        self.path.write_bytes(b"broken")
        with self.assertRaisesRegex(ValueError, "Unable to read"):
            generate_image(str(self.path))
        Image.new("RGB", (20, 20), "red").save(self.path)
        with patch("watchalong.theme_generator.MAX_IMAGE_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "20 MiB"):
                generate_image(str(self.path))
        with patch("watchalong.theme_generator.MAX_IMAGE_PIXELS", 1):
            with self.assertRaisesRegex(ValueError, "24 million"):
                generate_image(str(self.path))
        unsupported = self.path.with_suffix(".tiff")
        Image.new("RGB", (20, 20), "red").save(unsupported)
        with self.assertRaisesRegex(ValueError, "Unable to read"):
            generate_image(str(unsupported))


class ThemeWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.gui = QCoreApplication.instance() or QCoreApplication([])

    def setUp(self) -> None:
        self.controller = ThemeGenerationController()
        self.addCleanup(self.controller.wait_for_shutdown)
        self.addCleanup(self.controller.shutdown)
        self.results = []
        self.controller.resultReady.connect(self.results.append)

    def wait(self) -> None:
        loop = QEventLoop()
        self.controller.changed.connect(lambda: loop.quit() if not self.controller.busy else None)
        timeout = QTimer()
        timeout.setSingleShot(True)
        timeout.timeout.connect(loop.quit)
        timeout.start(10000)
        loop.exec()
        self.assertFalse(self.controller.busy, "Worker did not finish within ten seconds")

    def test_real_large_image_keeps_qt_responsive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "large.png"
            Image.new("RGB", (4000, 3000), "#237A64").save(source)
            timestamps = [time.monotonic()]
            timer = QTimer()
            timer.setInterval(10)
            timer.timeout.connect(lambda: timestamps.append(time.monotonic()))
            timer.start()
            self.controller.requestImage(source.as_uri(), "balanced")
            self.assertTrue(self.controller.busy)
            self.wait()
            timer.stop()
            self.assertEqual(self.controller.errorMessage, "")
            self.assertEqual(self.results[0]["candidates"][0]["seed"], "#237A64")
            self.assertGreater(len(timestamps), 5)
            gaps = [second - first for first, second in zip(timestamps, timestamps[1:])]
            self.assertLess(max(gaps), 0.2)
            print(f"Large-image Qt heartbeat: {len(gaps)} callbacks, largest gap {max(gaps) * 1000:.1f} ms")

    def test_error_recovery_and_latest_request_wins(self) -> None:
        self.controller.requestColor("not-a-color", "balanced")
        self.wait()
        self.assertIn("#RRGGBB", self.controller.errorMessage)
        self.controller.requestRandom("balanced")
        self.controller.requestColor("#FF3300", "vivid")
        self.wait()
        self.assertEqual(len(self.results), 1)
        self.assertEqual(self.results[0]["candidates"][0]["seed"], "#FF3300")

    def test_cancel_and_late_delivery_do_not_publish(self) -> None:
        self.controller.requestRandom("balanced")
        previous = self.controller._request_id
        self.controller.cancel()
        self.controller._deliver(previous, generate_random(seed=123), "")
        self.controller._deliver(previous, None, "old error")
        self.assertFalse(self.controller.busy)
        self.assertEqual(self.controller.errorMessage, "")
        self.assertEqual(self.results, [])

    def test_shutdown_cancels_and_reaps_worker(self) -> None:
        self.controller.requestRandom("balanced")
        self.controller.shutdown()
        self.controller.wait_for_shutdown()
        self.assertFalse(self.controller._thread.is_alive())
        self.controller.requestRandom("balanced")
        self.assertFalse(self.controller.busy)

    def test_isolated_worker_timeout(self) -> None:
        with self.assertRaises(TimeoutError):
            _generate_isolated({"kind": "random", "style": "balanced"}, threading.Event(), timeout=0)


if __name__ == "__main__":
    unittest.main()