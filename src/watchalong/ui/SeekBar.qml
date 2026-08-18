import QtQuick
import QtQuick.Controls

// Custom playback scrubber: accent "played" fill over a faint "buffered"
// underlay, with a hover time bubble and drag-to-seek (when seekable).
Item {
    id: bar

    property real duration: 0
    property real position: 0
    property real buffered: 0        // 0..1 download fraction
    property bool seekable: true
    signal seek(real seconds)

    implicitHeight: 18

    property bool dragging: false
    property real dragFraction: 0
    readonly property bool hot: mouse.containsMouse || dragging
    readonly property real playedFraction: dragging ? dragFraction
        : (duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0)

    Rectangle {
        id: track
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        height: bar.hot ? 6 : 4
        radius: height / 2
        color: Theme.withAlpha(Theme.text, 0.16)
        Behavior on height { NumberAnimation { duration: Theme.durFast } }

        Rectangle {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width * Math.max(0, Math.min(1, bar.buffered))
            height: parent.height
            radius: parent.radius
            color: Theme.withAlpha(Theme.text, 0.22)
        }
        Rectangle {
            id: played
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width * bar.playedFraction
            height: parent.height
            radius: parent.radius
            color: Theme.accent
        }
        Rectangle {
            width: bar.hot && bar.seekable ? 14 : 0
            height: width
            radius: width / 2
            color: Theme.accent
            anchors.verticalCenter: parent.verticalCenter
            x: played.width - width / 2
            Behavior on width { NumberAnimation { duration: Theme.durFast } }
        }
    }

    MouseArea {
        id: mouse
        anchors.fill: parent
        anchors.topMargin: -6
        anchors.bottomMargin: -6
        enabled: bar.seekable && bar.duration > 0
        hoverEnabled: true
        preventStealing: true
        cursorShape: Qt.PointingHandCursor

        function fractionAt(mx) { return Math.max(0, Math.min(1, mx / width)); }

        onPressed: (e) => { bar.dragging = true; bar.dragFraction = fractionAt(e.x); }
        onPositionChanged: (e) => { if (bar.dragging) bar.dragFraction = fractionAt(e.x); }
        onReleased: (e) => {
            bar.dragging = false;
            bar.seek(fractionAt(e.x) * bar.duration);
        }
    }

    Rectangle {
        id: bubble
        visible: mouse.containsMouse && bar.duration > 0
        color: Theme.surfaceElevated
        border.color: Theme.border
        border.width: 1
        radius: Theme.radiusSm
        height: bubbleLabel.implicitHeight + Theme.spacingSm
        width: bubbleLabel.implicitWidth + Theme.spacingMd
        y: -height - Theme.spacingSm
        x: Math.max(0, Math.min(bar.width - width, mouse.mouseX - width / 2))

        Label {
            id: bubbleLabel
            anchors.centerIn: parent
            text: Theme.fmtTime(Math.max(0, Math.min(1, mouse.mouseX / bar.width)) * bar.duration)
            color: Theme.text
            font.pixelSize: Theme.fontCaption
        }
    }
}
