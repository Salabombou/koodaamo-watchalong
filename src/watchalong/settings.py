from __future__ import annotations

import json
import math
import os
import tempfile
import uuid
from copy import deepcopy
from pathlib import Path

from PySide6.QtCore import QObject, Property, QStandardPaths, QUrl, Signal, Slot

from . import themes


def local_path(value: str) -> Path:
    url = QUrl(value)
    return Path(url.toLocalFile() if url.isLocalFile() else value)


def executable_path(value: str) -> str:
    if not value.strip():
        return ""
    path = local_path(value.strip())
    if not path.is_file() or (os.name != "nt" and not os.access(path, os.X_OK)):
        raise ValueError("Select an existing player executable")
    return str(path.resolve())


def defaults() -> dict:
    return {"version": 1, "identity": uuid.uuid4().hex, "firstRunDone": False,
            "username": "", "mpvPath": "", "vlcPath": "", "defaultPlayer": "builtin",
            "themeName": "Dark", "customThemes": [], "soundsEnabled": True,
            "soundVolume": 25, "reduceMotion": False}


class SettingsController(QObject):
    changed = Signal()
    errorOccurred = Signal(str)

    def __init__(self, path: Path | None = None, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._path = path or Path(QStandardPaths.writableLocation(QStandardPaths.AppConfigLocation)) / "settings.json"
        self._data = defaults()
        self._preview: dict | None = None
        self._load_error = ""
        if self._path.exists():
            try:
                if self._path.stat().st_size > 262_144:
                    raise ValueError("Settings file is too large")
                loaded = json.loads(self._path.read_text(encoding="utf-8"))
                self._data = self._validate(loaded, check_paths=False)
            except (OSError, ValueError, TypeError, KeyError) as exc:
                self._load_error = f"Saved settings could not be loaded: {exc}"

    @property
    def identity(self) -> str:
        return self._data["identity"]

    @Property("QVariantMap", notify=changed)
    def values(self) -> dict:
        return {key: deepcopy(value) for key, value in self._data.items() if key not in ("identity", "customThemes", "version")}

    @Property(bool, notify=changed)
    def firstRunDone(self) -> bool:
        return self._data["firstRunDone"]

    @Property(str, constant=True)
    def loadError(self) -> str:
        return self._load_error

    @Property("QVariantMap", notify=changed)
    def palette(self) -> dict:
        return deepcopy(self._active()["colors"])

    @Property(bool, notify=changed)
    def isDark(self) -> bool:
        return self._active()["isDark"]

    @Property("QVariantList", notify=changed)
    def availableThemes(self) -> list:
        return [{"name": document["name"], "isDark": document["isDark"],
                 "builtin": document["name"] in themes.BUILTINS}
                for document in [*themes.BUILTINS.values(), *self._data["customThemes"]]]

    @Property("QStringList", constant=True)
    def colorFields(self) -> list[str]:
        return list(themes.DARK)

    @Property("QStringList", notify=changed)
    def contrastWarnings(self) -> list[str]:
        return themes.contrast_warnings(self.palette)

    @Property("QVariantMap", constant=True)
    def detectedPaths(self) -> dict:
        from .players.mpv_external import _find_mpv
        from .players.vlc_external import _find_vlc
        return {"mpv": _find_mpv() or "", "vlc": _find_vlc() or ""}

    def _active(self) -> dict:
        return self._preview or themes.theme_document(self._data["themeName"], self._data["customThemes"])

    def _validate(self, data: object, check_paths: bool = True) -> dict:
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("Unsupported settings format")
        result = defaults()
        for key in result:
            if key in data:
                result[key] = deepcopy(data[key])
        if not isinstance(result["identity"], str) or len(result["identity"]) != 32:
            raise ValueError("Invalid profile identity")
        for key in ("firstRunDone", "soundsEnabled", "reduceMotion"):
            if not isinstance(result[key], bool):
                raise ValueError(f"{key} must be on or off")
        if result["username"] or result["firstRunDone"]:
            result["username"] = themes.clean_name(result["username"])
        if result["defaultPlayer"] not in ("builtin", "mpv", "vlc"):
            raise ValueError("Unknown player")
        if isinstance(result["soundVolume"], bool) or not isinstance(result["soundVolume"], (int, float)):
            raise ValueError("Sound volume must be a number")
        if not math.isfinite(result["soundVolume"]):
            raise ValueError("Sound volume must be finite")
        result["soundVolume"] = max(0, min(100, int(result["soundVolume"])))
        for key in ("mpvPath", "vlcPath"):
            if not isinstance(result[key], str):
                raise ValueError("Executable path must be text")
            if check_paths:
                result[key] = executable_path(result[key])
        if not isinstance(result["customThemes"], list) or len(result["customThemes"]) > 50:
            raise ValueError("Up to 50 custom themes are supported")
        result["customThemes"] = [themes.validate_theme(document) for document in result["customThemes"]]
        names = [document["name"].casefold() for document in result["customThemes"]]
        if len(set(names)) != len(names) or any(name in ("dark", "light") for name in names):
            raise ValueError("Theme names must be unique")
        themes.theme_document(result["themeName"], result["customThemes"])
        return result

    def _persist(self, data: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self._path.parent, delete=False) as output:
                temporary = Path(output.name)
                json.dump(data, output, indent=2, ensure_ascii=True)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self._path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        self._data = data
        self._preview = None
        self.changed.emit()

    @Slot("QVariantMap", bool, result=bool)
    def save(self, values: dict, finish_setup: bool = False) -> bool:
        try:
            data = deepcopy(self._data)
            for key in self.values:
                if key in values and key != "firstRunDone":
                    data[key] = values[key]
            if finish_setup:
                data["firstRunDone"] = True
            data = self._validate(data, check_paths=False)
            for key in ("mpvPath", "vlcPath"):
                if key in values:
                    data[key] = executable_path(data[key])
            self._persist(data)
            return True
        except (OSError, ValueError, TypeError) as exc:
            self.errorOccurred.emit(str(exc))
            return False

    @Slot(str, result=bool)
    def validateExecutable(self, path: str) -> bool:
        try:
            executable_path(path)
            return True
        except (OSError, ValueError):
            return False

    @Slot(str, str, result=bool)
    def validatePlayer(self, key: str, path: str) -> bool:
        try:
            if key == "builtin":
                return True
            from .players.mpv_external import MpvExternalPlayer
            from .players.vlc_external import VlcExternalPlayer
            backend = {"mpv": MpvExternalPlayer, "vlc": VlcExternalPlayer}.get(key)
            return backend is not None and backend.is_available(executable_path(path))
        except (OSError, ValueError):
            return False

    @Slot(str, result=str)
    def normalizePath(self, path: str) -> str:
        return str(local_path(path))

    @Slot(str)
    def previewTheme(self, name: str) -> None:
        try:
            self._preview = themes.theme_document(name, self._data["customThemes"])
            self.changed.emit()
        except ValueError as exc:
            self.errorOccurred.emit(str(exc))

    @Slot()
    def cancelPreview(self) -> None:
        self._preview = None
        self.changed.emit()

    @Slot("QVariantMap", result=bool)
    def previewDocument(self, document: dict) -> bool:
        try:
            self._preview = themes.validate_theme(document)
            self.changed.emit()
            return True
        except (ValueError, TypeError):
            return False

    @Slot(str, result="QVariantMap")
    def themeDocument(self, name: str) -> dict:
        try:
            return themes.theme_document(name, self._data["customThemes"])
        except ValueError:
            return {}

    @Slot("QVariantMap", result=bool)
    def saveTheme(self, document: dict) -> bool:
        try:
            document = themes.validate_theme(document)
            if document["name"].casefold() in ("dark", "light"):
                raise ValueError("Choose a name other than Dark or Light")
            data = deepcopy(self._data)
            data["customThemes"] = [existing for existing in data["customThemes"]
                                    if existing["name"].casefold() != document["name"].casefold()]
            data["customThemes"].append(document)
            data["themeName"] = document["name"]
            self._persist(self._validate(data, check_paths=False))
            return True
        except (OSError, ValueError, TypeError) as exc:
            self.errorOccurred.emit(str(exc))
            return False

    @Slot(str, result=bool)
    def removeTheme(self, name: str) -> bool:
        if name in themes.BUILTINS:
            self.errorOccurred.emit("Built-in themes cannot be deleted")
            return False
        try:
            data = deepcopy(self._data)
            data["customThemes"] = [document for document in data["customThemes"] if document["name"] != name]
            if data["themeName"] == name:
                data["themeName"] = "Dark"
            self._persist(data)
            return True
        except OSError as exc:
            self.errorOccurred.emit(str(exc))
            return False

    @Slot(str, result=bool)
    def importTheme(self, path: str) -> bool:
        try:
            source = local_path(path)
            if source.stat().st_size > themes.MAX_THEME_BYTES:
                raise ValueError("Theme file exceeds 16 KB")
            document = themes.validate_theme(json.loads(source.read_text(encoding="utf-8")))
            existing = {entry["name"].casefold() for entry in self.availableThemes}
            original = document["name"]
            suffix = 2
            while document["name"].casefold() in existing:
                document["name"] = original[:26] + f" ({suffix})"
                suffix += 1
            return self.saveTheme(document)
        except (OSError, ValueError, TypeError) as exc:
            self.errorOccurred.emit(str(exc))
            return False

    @Slot(str, str, result=bool)
    def exportTheme(self, name: str, path: str) -> bool:
        try:
            document = themes.theme_document(name, self._data["customThemes"])
            local_path(path).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
            return True
        except (OSError, ValueError) as exc:
            self.errorOccurred.emit(str(exc))
            return False