import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Dialogs

ApplicationWindow {
    id: root
    width: 1180
    height: 720
    minimumWidth: 720
    minimumHeight: 480
    visible: true
    title: "Koodaamo Watchalong"
    color: Theme.background

    Material.theme: Material.Dark
    Material.accent: Theme.accent
    Material.primary: Theme.accent
    Material.background: Theme.surface
    Material.foreground: Theme.text

    readonly property bool isFullscreen: visibility === Window.FullScreen

    function toggleFullscreen() {
        visibility = isFullscreen ? Window.Windowed : Window.FullScreen;
    }
    function exitFullscreen() {
        if (isFullscreen)
            visibility = Window.Windowed;
    }
    function openShareDialog() {
        shareDialog.open();
    }

    FileDialog {
        id: shareDialog
        title: "Choose a video to share"
        nameFilters: ["Video files (*.mp4 *.mkv *.webm *.avi *.mov *.m4v)", "All files (*)"]
        onAccepted: app.shareFile(selectedFile)
    }

    // Screen switch: join <-> player.
    Loader {
        id: screenLoader
        anchors.fill: parent
        sourceComponent: app.connected ? playerScreenComponent : joinScreenComponent
    }

    Component {
        id: joinScreenComponent
        JoinScreen {}
    }

    Component {
        id: playerScreenComponent
        PlayerScreen {}
    }

    // --- Error toast ---------------------------------------------------------
    Connections {
        target: app
        function onErrorOccurred(message) {
            toast.message = message;
            toast.shown = true;
            toastTimer.restart();
        }
    }

    Timer {
        id: toastTimer
        interval: 5000
        onTriggered: toast.shown = false
    }

    Rectangle {
        id: toast
        z: 1000
        property string message: ""
        property bool shown: false

        width: Math.min(toastLabel.implicitWidth + Theme.spacingXl * 2, root.width - Theme.spacingXl * 2)
        height: toastLabel.implicitHeight + Theme.spacingLg * 2
        radius: Theme.radiusMd
        color: Theme.danger
        anchors.horizontalCenter: parent.horizontalCenter
        y: shown ? parent.height - height - Theme.spacingXl : parent.height + height
        opacity: shown ? 1.0 : 0.0

        Behavior on y { NumberAnimation { duration: Theme.durNormal; easing.type: Easing.OutCubic } }
        Behavior on opacity { NumberAnimation { duration: Theme.durNormal } }

        Label {
            id: toastLabel
            anchors.centerIn: parent
            text: toast.message
            color: "white"
            font.pixelSize: Theme.fontBody
            font.weight: Font.Medium
        }

        MouseArea {
            anchors.fill: parent
            onClicked: toast.shown = false
        }
    }
}
