import QtQuick
import QtQuick.Controls

// Flat, round icon button with crisp hand-drawn (Canvas) glyphs so we ship no
// icon-font or image assets. Set `name` to pick a glyph and `text` for a tooltip.
AbstractButton {
    id: control

    property string name: ""
    property int iconSize: 22
    property color iconColor: Theme.text
    property color hoverColor: Theme.text
    property color activeColor: Theme.accent
    property bool active: false

    readonly property color effectiveColor: !enabled ? Theme.faint
                                             : active ? activeColor
                                             : hovered ? hoverColor
                                             : iconColor

    implicitWidth: 40
    implicitHeight: 40
    hoverEnabled: true
    opacity: enabled ? 1.0 : 0.4

    background: Rectangle {
        radius: Theme.radiusPill
        color: Theme.withAlpha(Theme.text, control.pressed ? 0.18 : control.hovered ? 0.10 : 0.0)
        Behavior on color { ColorAnimation { duration: Theme.durFast } }
    }

    contentItem: Item {
        Canvas {
            id: canvas
            width: control.iconSize
            height: control.iconSize
            anchors.centerIn: parent
            antialiasing: true

            onPaint: {
                var ctx = getContext("2d");
                ctx.reset();
                var col = control.effectiveColor;
                var s = Math.min(width, height) / 24;
                ctx.save();
                ctx.translate((width - 24 * s) / 2, (height - 24 * s) / 2);
                ctx.scale(s, s);
                ctx.fillStyle = col;
                ctx.strokeStyle = col;
                ctx.lineWidth = 2;
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                _draw(ctx, control.name);
                ctx.restore();
            }

            function _rr(ctx, x, y, w, h, r) {
                ctx.beginPath();
                ctx.moveTo(x + r, y);
                ctx.arcTo(x + w, y, x + w, y + h, r);
                ctx.arcTo(x + w, y + h, x, y + h, r);
                ctx.arcTo(x, y + h, x, y, r);
                ctx.arcTo(x, y, x + w, y, r);
                ctx.closePath();
            }

            function _draw(ctx, name) {
                switch (name) {
                case "play":
                    ctx.beginPath();
                    ctx.moveTo(7, 5); ctx.lineTo(20, 12); ctx.lineTo(7, 19);
                    ctx.closePath(); ctx.fill();
                    break;
                case "pause":
                    _rr(ctx, 6.5, 5, 3.6, 14, 1.4); ctx.fill();
                    _rr(ctx, 13.9, 5, 3.6, 14, 1.4); ctx.fill();
                    break;
                case "back10":
                    ctx.beginPath();
                    ctx.moveTo(11, 7); ctx.lineTo(6, 12); ctx.lineTo(11, 17);
                    ctx.moveTo(18, 7); ctx.lineTo(13, 12); ctx.lineTo(18, 17);
                    ctx.stroke();
                    break;
                case "forward10":
                    ctx.beginPath();
                    ctx.moveTo(6, 7); ctx.lineTo(11, 12); ctx.lineTo(6, 17);
                    ctx.moveTo(13, 7); ctx.lineTo(18, 12); ctx.lineTo(13, 17);
                    ctx.stroke();
                    break;
                case "volume":
                    ctx.beginPath();
                    ctx.moveTo(4, 9.5); ctx.lineTo(7.5, 9.5); ctx.lineTo(11.5, 6);
                    ctx.lineTo(11.5, 18); ctx.lineTo(7.5, 14.5); ctx.lineTo(4, 14.5);
                    ctx.closePath(); ctx.fill();
                    ctx.lineWidth = 1.6;
                    ctx.beginPath(); ctx.arc(12, 12, 4.2, -0.7, 0.7, false); ctx.stroke();
                    ctx.beginPath(); ctx.arc(12, 12, 7.2, -0.8, 0.8, false); ctx.stroke();
                    break;
                case "mute":
                    ctx.beginPath();
                    ctx.moveTo(4, 9.5); ctx.lineTo(7.5, 9.5); ctx.lineTo(11.5, 6);
                    ctx.lineTo(11.5, 18); ctx.lineTo(7.5, 14.5); ctx.lineTo(4, 14.5);
                    ctx.closePath(); ctx.fill();
                    ctx.beginPath();
                    ctx.moveTo(15, 9); ctx.lineTo(20, 15);
                    ctx.moveTo(20, 9); ctx.lineTo(15, 15);
                    ctx.stroke();
                    break;
                case "fullscreen":
                    ctx.beginPath(); ctx.moveTo(4, 8); ctx.lineTo(4, 4); ctx.lineTo(8, 4); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(16, 4); ctx.lineTo(20, 4); ctx.lineTo(20, 8); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(20, 16); ctx.lineTo(20, 20); ctx.lineTo(16, 20); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(8, 20); ctx.lineTo(4, 20); ctx.lineTo(4, 16); ctx.stroke();
                    break;
                case "fullscreenExit":
                    ctx.beginPath(); ctx.moveTo(4, 8); ctx.lineTo(8, 8); ctx.lineTo(8, 4); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(20, 8); ctx.lineTo(16, 8); ctx.lineTo(16, 4); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(16, 20); ctx.lineTo(16, 16); ctx.lineTo(20, 16); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(4, 16); ctx.lineTo(8, 16); ctx.lineTo(8, 20); ctx.stroke();
                    break;
                case "share":
                    ctx.beginPath(); ctx.moveTo(12, 4); ctx.lineTo(12, 14); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(8, 8); ctx.lineTo(12, 4); ctx.lineTo(16, 8); ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(7, 11); ctx.lineTo(7, 19); ctx.lineTo(17, 19); ctx.lineTo(17, 11);
                    ctx.stroke();
                    break;
                case "options":
                    ctx.beginPath(); ctx.moveTo(4, 8); ctx.lineTo(20, 8); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(4, 16); ctx.lineTo(20, 16); ctx.stroke();
                    ctx.beginPath(); ctx.arc(9, 8, 2.6, 0, Math.PI * 2); ctx.fill();
                    ctx.beginPath(); ctx.arc(15, 16, 2.6, 0, Math.PI * 2); ctx.fill();
                    break;
                case "leave":
                    ctx.beginPath();
                    ctx.moveTo(11, 4); ctx.lineTo(5, 4); ctx.lineTo(5, 20); ctx.lineTo(11, 20);
                    ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(10, 12); ctx.lineTo(20, 12); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(16, 8); ctx.lineTo(20, 12); ctx.lineTo(16, 16); ctx.stroke();
                    break;
                case "check":
                    ctx.beginPath();
                    ctx.moveTo(5, 12); ctx.lineTo(10, 17); ctx.lineTo(19, 7);
                    ctx.stroke();
                    break;
                }
            }

            Connections {
                target: control
                function onEffectiveColorChanged() { canvas.requestPaint(); }
                function onNameChanged() { canvas.requestPaint(); }
                function onIconSizeChanged() { canvas.requestPaint(); }
            }
        }
    }

    ToolTip.visible: hovered && text.length > 0
    ToolTip.text: text
    ToolTip.delay: 500
}
