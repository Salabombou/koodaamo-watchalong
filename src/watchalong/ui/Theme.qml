pragma Singleton
import QtQuick

// Central design tokens for the whole app: colours, spacing, radii, type scale,
// animation timings, plus a couple of shared formatting helpers.
QtObject {
    // --- Colours -------------------------------------------------------------
    readonly property bool isDark: preferences.isDark
    readonly property var palette: preferences.palette
    readonly property color background: palette.background
    readonly property color surface: palette.surface
    readonly property color surfaceElevated: palette.surfaceElevated
    readonly property color surfaceHover: palette.surfaceHover
    readonly property color border: palette.border
    readonly property color accent: palette.accent
    readonly property color accentHover: palette.accentHover
    readonly property color accentPressed: palette.accentPressed
    readonly property color accentText: palette.accentText
    readonly property color text: palette.text
    readonly property color subtext: palette.subtext
    readonly property color faint: palette.faint
    readonly property color danger: palette.danger
    readonly property color success: palette.success
    readonly property color warning: palette.warning
    readonly property color overlayScrim: palette.overlayScrim
    readonly property string fontFamily: uiFont.name
    property FontLoader uiFont: FontLoader { source: "fonts/SourceSans3.ttf" }

    // --- Spacing -------------------------------------------------------------
    readonly property int spacingXs: 4
    readonly property int spacingSm: 8
    readonly property int spacingMd: 12
    readonly property int spacingLg: 16
    readonly property int spacingXl: 24
    readonly property int spacingXxl: 32

    // --- Radii ---------------------------------------------------------------
    readonly property int radiusSm: 6
    readonly property int radiusMd: 8
    readonly property int radiusLg: 8
    readonly property int radiusPill: 999

    // --- Type scale ----------------------------------------------------------
    readonly property int fontCaption: 12
    readonly property int fontBody: 14
    readonly property int fontSubtitle: 16
    readonly property int fontTitle: 20
    readonly property int fontHeadline: 28
    readonly property int fontDisplay: 34

    // --- Motion --------------------------------------------------------------
    readonly property int durFast: preferences.values.reduceMotion ? 0 : 120
    readonly property int durNormal: preferences.values.reduceMotion ? 0 : 200
    readonly property int durSlow: preferences.values.reduceMotion ? 0 : 320

    // --- Helpers -------------------------------------------------------------
    function fmtTime(t) {
        if (isNaN(t) || t < 0)
            t = 0;
        var s = Math.floor(t % 60);
        var m = Math.floor((t / 60) % 60);
        var h = Math.floor(t / 3600);
        function pad(n) { return (n < 10 ? "0" : "") + n; }
        return (h > 0 ? h + ":" : "") + pad(m) + ":" + pad(s);
    }

    function withAlpha(base, alpha) {
        return Qt.rgba(base.r, base.g, base.b, alpha);
    }
}
