import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import QtMultimedia

Rectangle {
    id: playerScreen
    color: isBuiltin && app.hasMedia ? "black" : Theme.background

    readonly property bool canSeek: (app.isHost || app.allowSeek) && !app.selfIgnored && !app.transferring
    readonly property bool isBuiltin: app.playerKey === "builtin"
    readonly property bool loading: app.playerLoading
    readonly property bool wide: width >= 1000 && !ApplicationWindow.window.isFullscreen
    property bool roomOpen: true
    readonly property int panelWidth: wide && roomOpen ? 280 : 0

    property bool userActive: true
    property bool hoveringControls: topHover.hovered || bottomHover.hovered
    readonly property bool controlsVisible: userActive || hoveringControls
                                            || !app.playing || !app.hasMedia || !ApplicationWindow.window.isFullscreen

    opacity: 0
    Component.onCompleted: opacity = 1
    Behavior on opacity { NumberAnimation { duration: Theme.durSlow; easing.type: Easing.OutCubic } }

    function reveal() {
        userActive = true;
        hideTimer.restart();
    }
    function togglePlay() {
        if (app.canReady)
            app.toggleReady();
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
        anchors { left: parent.left; right: parent.right; top: topBar.bottom; bottom: controls.top }
        anchors.rightMargin: playerScreen.panelWidth
        fillMode: VideoOutput.PreserveAspectFit
        visible: playerScreen.isBuiltin
        Component.onCompleted: Qt.callLater(() => app.setVideoItem(video))
    }

    // --- Activity / click layer (above the video, below the UI) --------------
    MouseArea {
        id: activity
        anchors.fill: parent
        anchors.rightMargin: playerScreen.panelWidth
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
        anchors.horizontalCenterOffset: -playerScreen.panelWidth / 2
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
        anchors.horizontalCenterOffset: -playerScreen.panelWidth / 2
        width: Math.min(420, parent.width - 48)
        spacing: Theme.spacingMd
        visible: playerScreen.loading
        LoadingSpinner {
            objectName: "playerLoadingSpinner"
            running: playerScreen.loading
            Layout.alignment: Qt.AlignHCenter
        }
        Label {
            text: app.mediaPreparing ? "Preparing video..." : playerScreen.isBuiltin ? "Loading media..."
                  : "Opening " + (app.playerKey === "vlc" ? "VLC" : "mpv") + "..."
            textFormat: Text.PlainText
            color: Theme.subtext
            font.pixelSize: Theme.fontBody
            Layout.alignment: Qt.AlignHCenter
        }
    }

    ColumnLayout {
        anchors.centerIn: parent
        anchors.horizontalCenterOffset: -playerScreen.panelWidth / 2
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
        anchors.rightMargin: playerScreen.panelWidth
        onParticipantsRequested: {
            if (playerScreen.wide) playerScreen.roomOpen = !playerScreen.roomOpen;
            else roomDrawer.open();
        }
        opacity: playerScreen.controlsVisible ? 1 : 0
        visible: opacity > 0
        Behavior on opacity { NumberAnimation { duration: Theme.durNormal } }
        HoverHandler { id: topHover }
    }

    ControlsOverlay {
        id: controls
        anchors { bottom: parent.bottom; left: parent.left; right: parent.right }
        anchors.rightMargin: playerScreen.panelWidth
        opacity: playerScreen.controlsVisible ? 1 : 0
        visible: opacity > 0
        Behavior on opacity { NumberAnimation { duration: Theme.durNormal } }
        HoverHandler { id: bottomHover }
    }

    ParticipantsPanel {
        anchors { right: parent.right; top: parent.top; bottom: parent.bottom }
        width: playerScreen.panelWidth
        visible: width > 0
    }
    Drawer {
        id: roomDrawer
        width: Math.min(320, playerScreen.width - 48)
        height: playerScreen.height
        edge: Qt.RightEdge
        ParticipantsPanel { anchors.fill: parent }
    }
    CountdownOverlay {
        anchors.centerIn: parent
        anchors.horizontalCenterOffset: -playerScreen.panelWidth / 2
        z: 20
    }
    ColumnLayout {
        anchors.centerIn: parent
        anchors.horizontalCenterOffset: -playerScreen.panelWidth / 2
        visible: app.syncLoading && !app.playerLoading
        LoadingSpinner { running: parent.visible; Layout.alignment: Qt.AlignHCenter }
        Label { text: "Synchronizing with host..."; color: Theme.text }
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
    Shortcut { sequence: "P"; onActivated: playerScreen.wide ? playerScreen.roomOpen = !playerScreen.roomOpen : roomDrawer.open() }
}
