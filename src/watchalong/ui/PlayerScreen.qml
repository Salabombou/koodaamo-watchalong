import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import QtMultimedia

Rectangle {
    id: playerScreen
    color: "black"

    readonly property bool canPause: app.isHost || app.allowPause
    readonly property bool canSeek: app.isHost || app.allowSeek
    readonly property bool isBuiltin: app.playerKey === "builtin"
    readonly property bool loading: app.playerLoading

    property bool userActive: true
    property bool hoveringControls: topHover.hovered || bottomHover.hovered
    readonly property bool controlsVisible: userActive || hoveringControls
                                            || !app.playing || !app.hasMedia

    opacity: 0
    Component.onCompleted: opacity = 1
    Behavior on opacity { NumberAnimation { duration: Theme.durSlow; easing.type: Easing.OutCubic } }

    function reveal() {
        userActive = true;
        hideTimer.restart();
    }
    function togglePlay() {
        if (canPause && app.hasMedia)
            app.playing ? app.pausePressed() : app.playPressed();
    }
    function seekRel(delta) {
        if (!canSeek || !app.hasMedia)
            return;
        var target = app.position + delta;
        if (app.duration > 0)
            target = Math.min(app.duration, target);
        app.seekTo(Math.max(0, target));
    }
    function changeVolume(delta) {
        app.setVolume(Math.max(0, Math.min(100, app.volume + delta)));
    }
    function toggleMute() {
        app.setVolume(app.volume > 0 ? 0 : 100);
    }

    Timer {
        id: hideTimer
        interval: 2500
        onTriggered: {
            if (app.playing && app.hasMedia && !playerScreen.hoveringControls)
                playerScreen.userActive = false;
        }
    }

    // --- Video surface -------------------------------------------------------
    VideoOutput {
        id: video
        objectName: "video"
        anchors.fill: parent
        fillMode: VideoOutput.PreserveAspectFit
        visible: playerScreen.isBuiltin
        Component.onCompleted: app.setVideoItem(this)
    }

    // --- Activity / click layer (above the video, below the UI) --------------
    MouseArea {
        id: activity
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: playerScreen.controlsVisible ? Qt.ArrowCursor : Qt.BlankCursor
        onPositionChanged: playerScreen.reveal()
        onClicked: {
            playerScreen.reveal();
            clickTimer.restart();
        }
        onDoubleClicked: {
            clickTimer.stop();
            ApplicationWindow.window.toggleFullscreen();
        }
    }

    Timer {
        id: clickTimer
        interval: 220
        onTriggered: playerScreen.togglePlay()
    }

    // Placeholder shown for external players or when nothing is loaded.
    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width - Theme.spacingXxl * 2, 420)
        spacing: Theme.spacingLg
        visible: !playerScreen.loading && app.playerError.length === 0
             && (!app.hasMedia || !playerScreen.isBuiltin)

        Rectangle {
            Layout.alignment: Qt.AlignHCenter
            implicitWidth: 88; implicitHeight: 88; radius: 44
            color: Theme.surfaceElevated
            border.color: Theme.border
            border.width: 1
            IconButton {
                anchors.centerIn: parent
                name: playerScreen.isBuiltin ? "play" : "share"
                iconSize: 34
                iconColor: Theme.subtext
                enabled: false
                opacity: 1
            }
        }
        Label {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            color: Theme.text
            font.pixelSize: Theme.fontSubtitle
            font.weight: Font.Medium
            text: !playerScreen.isBuiltin ? "Playing in your external player window"
                  : app.isHost ? "Share a video to start the watch party"
                  : "Waiting for the host to share a file…"
        }
        Button {
            Layout.alignment: Qt.AlignHCenter
            visible: app.isHost && app.hasMedia === false && playerScreen.isBuiltin
            highlighted: true
            text: "Share a file…"
            onClicked: ApplicationWindow.window.openShareDialog()
        }
    }

    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(420, parent.width - 48)
        spacing: Theme.spacingMd
        visible: playerScreen.loading
        BusyIndicator {
            running: playerScreen.loading
            Layout.alignment: Qt.AlignHCenter
        }
        Label {
            text: playerScreen.isBuiltin ? "Loading media..."
                  : "Opening " + (app.playerKey === "vlc" ? "VLC" : "mpv") + "..."
            textFormat: Text.PlainText
            color: Theme.subtext
            font.pixelSize: Theme.fontBody
            Layout.alignment: Qt.AlignHCenter
        }
    }

    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(420, parent.width - 48)
        spacing: Theme.spacingMd
        visible: app.playerError.length > 0
        Label {
            text: "Player could not open"
            color: Theme.text
            font.pixelSize: Theme.fontSubtitle
        }
        Label {
            text: app.playerError
            textFormat: Text.PlainText
            color: Theme.subtext
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }
        RowLayout {
            Button { text: "Retry"; onClicked: app.retryPlayer() }
            Button { text: "Use built-in"; onClicked: app.selectPlayer("builtin") }
        }
    }

    // --- Overlays (above the click layer) ------------------------------------
    TopBar {
        id: topBar
        anchors { top: parent.top; left: parent.left; right: parent.right }
        opacity: playerScreen.controlsVisible ? 1 : 0
        visible: opacity > 0
        Behavior on opacity { NumberAnimation { duration: Theme.durNormal } }
        HoverHandler { id: topHover }
    }

    ControlsOverlay {
        id: controls
        anchors { bottom: parent.bottom; left: parent.left; right: parent.right }
        opacity: playerScreen.controlsVisible ? 1 : 0
        visible: opacity > 0
        Behavior on opacity { NumberAnimation { duration: Theme.durNormal } }
        HoverHandler { id: bottomHover }
    }

    // --- Keyboard shortcuts --------------------------------------------------
    Shortcut { sequence: "Space"; onActivated: playerScreen.togglePlay() }
    Shortcut { sequence: "Left"; onActivated: playerScreen.seekRel(-10) }
    Shortcut { sequence: "Right"; onActivated: playerScreen.seekRel(10) }
    Shortcut { sequence: "Up"; onActivated: playerScreen.changeVolume(5) }
    Shortcut { sequence: "Down"; onActivated: playerScreen.changeVolume(-5) }
    Shortcut { sequence: "F"; onActivated: ApplicationWindow.window.toggleFullscreen() }
    Shortcut { sequence: "Escape"; onActivated: ApplicationWindow.window.exitFullscreen() }
    Shortcut { sequence: "M"; onActivated: playerScreen.toggleMute() }
}
