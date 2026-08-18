import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

Rectangle {
    id: joinScreen
    color: Theme.background

    // Fade in when the screen appears.
    opacity: 0
    Component.onCompleted: opacity = 1
    Behavior on opacity { NumberAnimation { duration: Theme.durSlow; easing.type: Easing.OutCubic } }

    // Subtle accent glow behind the card.
    Rectangle {
        anchors.centerIn: card
        width: card.width * 1.6
        height: card.height * 1.6
        radius: width / 2
        gradient: Gradient {
            GradientStop { position: 0.0; color: Theme.withAlpha(Theme.accent, 0.22) }
            GradientStop { position: 1.0; color: "transparent" }
        }
    }

    function submit(asHost) {
        app.startRoom(roomField.text, passField.text, asHost);
    }

    Rectangle {
        id: card
        anchors.centerIn: parent
        width: Math.min(440, joinScreen.width - Theme.spacingXl * 2)
        height: content.implicitHeight + Theme.spacingXxl * 2
        radius: Theme.radiusLg
        color: Theme.surfaceElevated
        border.color: Theme.border
        border.width: 1

        ColumnLayout {
            id: content
            anchors.centerIn: parent
            width: parent.width - Theme.spacingXxl * 2
            spacing: Theme.spacingLg

            ColumnLayout {
                Layout.fillWidth: true
                spacing: Theme.spacingXs

                RowLayout {
                    Layout.alignment: Qt.AlignHCenter
                    spacing: Theme.spacingSm

                    Rectangle {
                        implicitWidth: 12; implicitHeight: 12; radius: 6
                        color: Theme.accent
                        Layout.alignment: Qt.AlignVCenter
                    }
                    Label {
                        text: "Koodaamo Watchalong"
                        color: Theme.text
                        font.pixelSize: Theme.fontTitle
                        font.weight: Font.DemiBold
                    }
                }
                Label {
                    Layout.alignment: Qt.AlignHCenter
                    text: "Watch together, in sync — peer to peer."
                    color: Theme.subtext
                    font.pixelSize: Theme.fontBody
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.topMargin: Theme.spacingSm
                spacing: Theme.spacingSm

                Label {
                    text: "Room code"
                    color: Theme.subtext
                    font.pixelSize: Theme.fontCaption
                }
                TextField {
                    id: roomField
                    Layout.fillWidth: true
                    placeholderText: "e.g. movie-night"
                    selectByMouse: true
                    Keys.onReturnPressed: joinScreen.submit(false)
                }

                Label {
                    text: "Password (optional)"
                    color: Theme.subtext
                    font.pixelSize: Theme.fontCaption
                    Layout.topMargin: Theme.spacingXs
                }
                TextField {
                    id: passField
                    Layout.fillWidth: true
                    placeholderText: "Shared secret"
                    echoMode: showPass.checked ? TextInput.Normal : TextInput.Password
                    selectByMouse: true
                    Keys.onReturnPressed: joinScreen.submit(false)
                }
                CheckBox {
                    id: showPass
                    text: "Show password"
                    font.pixelSize: Theme.fontCaption
                }
            }

            RowLayout {
                Layout.fillWidth: true
                Layout.topMargin: Theme.spacingSm
                spacing: Theme.spacingMd

                Button {
                    text: "Join room"
                    flat: true
                    Layout.fillWidth: true
                    onClicked: joinScreen.submit(false)
                }
                Button {
                    text: "Host room"
                    highlighted: true
                    Layout.fillWidth: true
                    onClicked: joinScreen.submit(true)
                }
            }

            RowLayout {
                Layout.alignment: Qt.AlignHCenter
                Layout.topMargin: Theme.spacingXs
                spacing: Theme.spacingSm
                visible: app.statusText.length > 0 && app.statusText !== "Not connected"

                BusyIndicator {
                    running: app.statusText.indexOf("Connecting") === 0
                    visible: running
                    implicitWidth: 18
                    implicitHeight: 18
                }
                Label {
                    text: app.statusText
                    color: Theme.subtext
                    font.pixelSize: Theme.fontCaption
                }
            }
        }
    }
}
