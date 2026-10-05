from __future__ import annotations

import re
from copy import deepcopy

FORMAT = "koodaamo-watchalong-theme"
MAX_THEME_BYTES = 16_384

DARK = {
    "background": "#151719", "surface": "#1D2023", "surfaceElevated": "#262A2E",
    "surfaceHover": "#33383D", "border": "#464D53", "accent": "#77DACA",
    "accentHover": "#99E5D9", "accentPressed": "#50BFAE", "accentText": "#102824",
    "text": "#F4F6F7", "subtext": "#B3BDC4", "faint": "#929DA6",
    "danger": "#FA9197", "success": "#80DCAC", "warning": "#F2CE7B",
    "overlayScrim": "#B3000000",
}
LIGHT = {
    "background": "#F2F5F6", "surface": "#FFFFFF", "surfaceElevated": "#E7ECEF",
    "surfaceHover": "#DCE4E8", "border": "#ADBCC5", "accent": "#006E65",
    "accentHover": "#00574F", "accentPressed": "#004840", "accentText": "#FFFFFF",
    "text": "#182328", "subtext": "#4F6069", "faint": "#60717A",
    "danger": "#B32735", "success": "#187846", "warning": "#80600B",
    "overlayScrim": "#80000000",
}
BUILTINS = {
    "Dark": {"format": FORMAT, "version": 1, "name": "Dark", "isDark": True, "colors": DARK},
    "Light": {"format": FORMAT, "version": 1, "name": "Light", "isDark": False, "colors": LIGHT},
}


def clean_name(value: object, limit: int = 24) -> str:
    if not isinstance(value, str):
        raise ValueError("Name must be text")
    name = "".join(character for character in value if character.isprintable()).strip()
    if not name or len(name) > limit:
        raise ValueError(f"Name must contain 1 to {limit} characters")
    return name


def validate_theme(document: object) -> dict:
    if not isinstance(document, dict) or document.get("format") != FORMAT or document.get("version") != 1:
        raise ValueError("Unsupported theme file")
    name = clean_name(document.get("name"), 32)
    if not isinstance(document.get("isDark"), bool):
        raise ValueError("Theme must specify a dark or light control style")
    colors = document.get("colors")
    if not isinstance(colors, dict) or set(colors) != set(DARK):
        raise ValueError("Theme must contain exactly the supported color tokens")
    for color in colors.values():
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", color):
            raise ValueError("Colors must be #RRGGBB or #AARRGGBB")
    return {"format": FORMAT, "version": 1, "name": name,
            "isDark": document["isDark"], "colors": {key: value.upper() for key, value in colors.items()}}


def theme_document(name: str, custom: list[dict]) -> dict:
    for document in [*BUILTINS.values(), *custom]:
        if document["name"] == name:
            return deepcopy(document)
    raise ValueError("Theme does not exist")


def contrast_warnings(colors: dict) -> list[str]:
    def luminance(color: str) -> float:
        channels = [int(color[-6:][offset:offset + 2], 16) / 255 for offset in (0, 2, 4)]
        linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
        return sum(value * weight for value, weight in zip(linear, (0.2126, 0.7152, 0.0722)))

    warnings = []
    for foreground, background in (("text", "background"), ("subtext", "background"), ("accentText", "accent")):
        levels = sorted((luminance(colors[foreground]), luminance(colors[background])))
        if (levels[1] + 0.05) / (levels[0] + 0.05) < 4.5:
            warnings.append(f"{foreground} / {background}: contrast below 4.5:1")
    return warnings