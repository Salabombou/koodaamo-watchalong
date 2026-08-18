pragma Singleton
import QtQuick

// Central design tokens for the whole app: colours, spacing, radii, type scale,
// animation timings, plus a couple of shared formatting helpers.
QtObject {
    // --- Colours -------------------------------------------------------------
    readonly property color background: "#0E0F13"
    readonly property color surface: "#16181F"
    readonly property color surfaceElevated: "#1E212B"
    readonly property color surfaceHover: "#272B36"
    readonly property color border: "#2A2E3A"

    readonly property color accent: "#7C5CFF"
    readonly property color accentHover: "#8E72FF"
    readonly property color accentPressed: "#6A49F0"

    readonly property color text: "#F5F6FA"
    readonly property color subtext: "#9AA0AE"
    readonly property color faint: "#5C6270"

    readonly property color danger: "#FF4D5E"
    readonly property color success: "#39D98A"

    readonly property color overlayScrim: "#B3000000"

    // --- Spacing -------------------------------------------------------------
    readonly property int spacingXs: 4
    readonly property int spacingSm: 8
    readonly property int spacingMd: 12
    readonly property int spacingLg: 16
    readonly property int spacingXl: 24
    readonly property int spacingXxl: 32

    // --- Radii ---------------------------------------------------------------
    readonly property int radiusSm: 6
    readonly property int radiusMd: 10
    readonly property int radiusLg: 16
    readonly property int radiusPill: 999

    // --- Type scale ----------------------------------------------------------
    readonly property int fontCaption: 12
    readonly property int fontBody: 14
    readonly property int fontSubtitle: 16
    readonly property int fontTitle: 20
    readonly property int fontHeadline: 28
    readonly property int fontDisplay: 34

    // --- Motion --------------------------------------------------------------
    readonly property int durFast: 120
    readonly property int durNormal: 200
    readonly property int durSlow: 320

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
