from __future__ import annotations

import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

from watchalong.settings import SettingsController
from watchalong.themes import BUILTINS, contrast_warnings, validate_theme


class SettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "settings.json"
        self.settings = SettingsController(self.path)

    def custom_theme(self) -> dict:
        document = deepcopy(BUILTINS["Dark"])
        document["name"] = "Cinema"
        return document

    def test_first_run_persists_profile_and_identity(self) -> None:
        self.assertFalse(self.settings.firstRunDone)
        self.assertTrue(self.settings.save({"username": " Alice ", "themeName": "Light"}, True))
        restored = SettingsController(self.path)
        self.assertEqual(restored.values["username"], "Alice")
        self.assertEqual(restored.identity, self.settings.identity)
        self.assertTrue(restored.firstRunDone)
        self.assertFalse(restored.isDark)

    def test_setup_requires_username(self) -> None:
        self.assertFalse(self.settings.save({}, True))
        self.assertFalse(self.path.exists())

    def test_nonfinite_volume_is_rejected(self) -> None:
        for volume in (float("nan"), float("inf")):
            self.assertFalse(self.settings.save({"soundVolume": volume}, False))

    def test_corrupt_settings_offer_setup_without_overwriting(self) -> None:
        self.path.write_text("broken", encoding="utf-8")
        restored = SettingsController(self.path)
        self.assertFalse(restored.firstRunDone)
        self.assertTrue(restored.loadError)
        self.assertEqual(self.path.read_text(), "broken")

    def test_failed_write_keeps_previous_settings(self) -> None:
        with patch("watchalong.settings.os.replace", side_effect=OSError("Disk full")):
            self.assertFalse(self.settings.save({"username": "Alice"}, True))
        self.assertFalse(self.settings.firstRunDone)
        self.assertEqual(list(self.path.parent.iterdir()), [])

    def test_theme_roundtrip_does_not_export_profile(self) -> None:
        self.settings.save({"username": "Alice"}, True)
        self.assertTrue(self.settings.saveTheme(self.custom_theme()))
        exported = self.path.parent / "cinema.watchalong-theme.json"
        self.assertTrue(self.settings.exportTheme("Cinema", str(exported)))
        self.assertNotIn("username", json.loads(exported.read_text()))
        self.settings.removeTheme("Cinema")
        self.assertTrue(self.settings.importTheme(exported.as_uri()))
        self.assertEqual(self.settings.values["themeName"], "Cinema")

    def test_import_collision_does_not_overwrite(self) -> None:
        self.settings.saveTheme(self.custom_theme())
        exported = self.path.parent / "cinema.json"
        self.settings.exportTheme("Cinema", str(exported))
        self.assertTrue(self.settings.importTheme(str(exported)))
        self.assertEqual(self.settings.values["themeName"], "Cinema (2)")

    def test_theme_rejects_invalid_colors_and_unknown_tokens(self) -> None:
        for change in ({"text": "not-a-color"}, {"executable": "malicious"}):
            document = self.custom_theme()
            document["colors"].update(change)
            with self.assertRaises(ValueError):
                validate_theme(document)

    def test_large_import_is_rejected(self) -> None:
        source = self.path.parent / "large.json"
        source.write_bytes(b" " * 16_385)
        self.assertFalse(self.settings.importTheme(str(source)))

    def test_builtin_presets_pass_contrast_checks(self) -> None:
        for document in BUILTINS.values():
            self.assertEqual(contrast_warnings(document["colors"]), [])

    def test_preview_is_reversible(self) -> None:
        self.settings.previewTheme("Light")
        self.assertFalse(self.settings.isDark)
        self.settings.cancelPreview()
        self.assertTrue(self.settings.isDark)

    def test_builtins_cannot_be_overwritten_or_deleted(self) -> None:
        self.assertFalse(self.settings.saveTheme(BUILTINS["Dark"]))
        self.assertFalse(self.settings.removeTheme("Light"))


if __name__ == "__main__":
    unittest.main()