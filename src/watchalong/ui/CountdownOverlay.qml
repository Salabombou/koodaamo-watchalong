import QtQuick
import QtQuick.Controls

Item {
    id: countdown
    objectName: "countdownOverlay"
    property real remaining: app.countdownRemaining
    readonly property int seconds: Math.floor(remaining)
    readonly property real fraction: remaining > 0 ? (remaining % 1 || 1) : 0
    property int lastSecond: -1
    onSecondsChanged: {
        if (visible && seconds !== lastSecond && seconds >= 0) Sounds.tick();
        lastSecond = seconds;
    }
    onVisibleChanged: { if (visible) Sounds.tick(); else lastSecond = -1; }
    visible: app.phase === "countdown" && remaining > 0
    width: 160
    height: 160
    Rectangle { anchors.fill: parent; radius: 80; color: Theme.surface; opacity: 0.92 }
    Canvas {
        id: pie
        anchors.fill: parent
        antialiasing: true
        onPaint: {
            var context = getContext("2d");
            context.reset();
            context.fillStyle = Theme.withAlpha(Theme.accent, 0.35);
            context.beginPath();
            context.moveTo(80, 80);
            context.arc(80, 80, 72, -Math.PI / 2, -Math.PI / 2 + countdown.fraction * Math.PI * 2);
            context.closePath();
            context.fill();
            context.strokeStyle = Theme.border;
            context.lineWidth = 2;
            context.beginPath();
            context.arc(80, 80, 74, 0, Math.PI * 2);
            context.stroke();
        }
        Connections {
            target: countdown
            function onRemainingChanged() { pie.requestPaint(); }
        }
        Connections { target: preferences; function onChanged() { pie.requestPaint(); } }
    }
    Label {
        objectName: "countdownNumber"
        anchors.centerIn: parent
        text: countdown.seconds
        color: Theme.text
        font.pixelSize: 56
        font.weight: Font.DemiBold
        Accessible.name: "Playback starts in " + countdown.seconds + " seconds"
    }
}