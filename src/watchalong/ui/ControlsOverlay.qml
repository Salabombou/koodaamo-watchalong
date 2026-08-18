import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

// Bottom gradient overlay: scrubber plus the full playback control row.
Item {
    id: overlay
    implicitHeight: layout.implicitHeight + Theme.spacingLg * 2

    readonly property bool canPause: app.isHost || app.allowPause
    readonly property bool canSeek: app.isHost || app.allowSeek

    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop { position: 0.0; color: "transparent" }
            GradientStop { position: 1.0; color: Theme.withAlpha(Theme.background, 0.92) }
        }
    }

    // Absorb clicks so they don't reach the play/pause layer beneath.
    MouseArea { anchors.fill: parent }

    ColumnLayout {
        id: layout
        anchors.fill: parent
        anchors.margins: Theme.spacingLg
        spacing: Theme.spacingSm

        SeekBar {
            Layout.fillWidth: true
            duration: app.duration
            position: app.position
            buffered: app.progress
            seekable: overlay.canSeek
            onSeek: (seconds) => app.seekTo(seconds)
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.spacingXs

            IconButton {
                name: app.playing ? "pause" : "play"
                iconSize: 24
                enabled: overlay.canPause && app.hasMedia
                text: app.playing ? "Pause" : "Play"
                onClicked: app.playing ? app.pausePressed() : app.playPressed()
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
                color: Theme.subtext
                font.pixelSize: Theme.fontCaption
                font.family: "monospace"
                Layout.leftMargin: Theme.spacingSm
            }

            Item { Layout.fillWidth: true }

            VolumeControl {}

            ComboBox {
                id: playerCombo
                Layout.preferredWidth: 168
                model: app.availablePlayers
                textRole: "label"
                valueRole: "key"
                Component.onCompleted: currentIndex = indexOfValue(app.playerKey)
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
                        text: "Clients can pause"
                        checkable: true
                        checked: app.allowPause
                        onToggled: app.setOptions(checked, app.allowSeek)
                    }
                    MenuItem {
                        text: "Clients can seek"
                        checkable: true
                        checked: app.allowSeek
                        onToggled: app.setOptions(app.allowPause, checked)
                    }
                }
            }

            IconButton {
                name: "share"
                visible: app.isHost
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
