import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

// Bottom gradient overlay: scrubber plus the full playback control row.
Item {
    id: overlay
    implicitHeight: layout.implicitHeight + Theme.spacingLg * 2

    readonly property bool canSeek: (app.isHost || app.allowSeek) && !app.selfIgnored && !app.transferring

    Rectangle {
        anchors.fill: parent
        color: Theme.surface
    }

    // Absorb clicks so they don't reach the play/pause layer beneath.
    MouseArea { anchors.fill: parent }

    ColumnLayout {
        id: layout
        anchors.fill: parent
        anchors.margins: Theme.spacingLg
        spacing: Theme.spacingSm

        SeekBar {
            objectName: "playbackSeekBar"
            Layout.fillWidth: true
            Layout.minimumHeight: implicitHeight
            duration: app.duration
            position: app.position
            buffered: app.progress
            seekable: overlay.canSeek
            onSeek: (seconds) => app.seekTo(seconds)
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.minimumHeight: implicitHeight
            spacing: Theme.spacingXs

            Button {
                objectName: "readyButton"
                text: app.selfIgnored ? "Ignored" : app.selfReady ? "Unready" : "Ready"
                implicitWidth: 108
                Layout.minimumWidth: 108
                implicitHeight: 44
                topInset: 0
                bottomInset: 0
                topPadding: 8
                bottomPadding: 8
                leftPadding: 12
                rightPadding: 12
                enabled: app.canReady
                highlighted: app.selfReady
                icon.source: app.selfReady ? "icons/pause.svg" : "icons/play.svg"
                icon.color: app.selfReady ? Theme.accentText : Theme.text
                background: Rectangle {
                    radius: Theme.radiusSm
                    color: app.selfReady ? parent.down ? Theme.accentPressed : parent.hovered ? Theme.accentHover : Theme.accent
                                         : parent.down || parent.hovered ? Theme.surfaceHover : Theme.surfaceElevated
                }
                onClicked: app.toggleReady()
                ToolTip.visible: hovered && app.selfIgnored
                ToolTip.text: "The host has ignored you"
            }
            IconButton {
                name: "back10"
                enabled: overlay.canSeek && app.hasMedia
                text: "Back 10s"
                onClicked: app.seekTo(Math.max(0, app.position - 10))
            }
            IconButton {
                name: "forward10"
                enabled: overlay.canSeek && app.hasMedia
                text: "Forward 10s"
                onClicked: app.seekTo(app.duration > 0 ? Math.min(app.duration, app.position + 10)
                                                       : app.position + 10)
            }

            Label {
                text: Theme.fmtTime(app.position) + "  /  " + Theme.fmtTime(app.duration)
                visible: overlay.width >= 740
                color: Theme.subtext
                font.pixelSize: Theme.fontCaption
                font.family: Theme.fontFamily
                Layout.leftMargin: Theme.spacingSm
            }

            Item { Layout.fillWidth: true }

            VolumeControl {}

            ComboBox {
                id: playerCombo
                Layout.preferredWidth: overlay.width < 700 ? 118 : 156
                model: app.availablePlayers
                textRole: "label"
                valueRole: "key"
                displayText: currentValue === "vlc" ? "VLC" : currentValue === "mpv" ? "mpv" : "Built-in"
                Component.onCompleted: currentIndex = indexOfValue(app.playerKey)
                Connections { target: app; function onChanged() { playerCombo.currentIndex = playerCombo.indexOfValue(app.playerKey); } }
                onActivated: app.selectPlayer(currentValue)

                delegate: ItemDelegate {
                    id: playerDelegate
                    required property var model
                    required property int index
                    width: playerCombo.width
                    enabled: playerDelegate.model.available
                    text: playerDelegate.model.label + (playerDelegate.model.available ? "" : "  (unavailable)")
                    font.pixelSize: Theme.fontBody
                    highlighted: playerCombo.highlightedIndex === playerDelegate.index
                }
            }

            IconButton {
                name: "options"
                visible: app.isHost
                active: optionsMenu.opened
                text: "Room options"
                onClicked: optionsMenu.open()

                Menu {
                    id: optionsMenu
                    y: -implicitHeight - Theme.spacingSm

                    MenuItem {
                        text: "Clients can seek"
                        checkable: true
                        checked: app.allowSeek
                        onToggled: app.setOptions(false, checked)
                    }
                }
            }

            IconButton {
                name: "share"
                visible: app.isHost
                enabled: !app.mediaPreparing && !app.transferring
                text: "Share a file"
                onClicked: ApplicationWindow.window.openShareDialog()
            }

            IconButton {
                name: ApplicationWindow.window && ApplicationWindow.window.isFullscreen
                      ? "fullscreenExit" : "fullscreen"
                text: "Fullscreen"
                onClicked: ApplicationWindow.window.toggleFullscreen()
            }
        }
    }
}
