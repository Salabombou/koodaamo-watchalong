import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Top gradient overlay: media title on the left, live P2P stats + leave on the right.
Item {
    id: topBar
    implicitHeight: 64

    component Chip: Rectangle {
        property alias text: chipLabel.text
        implicitWidth: chipLabel.implicitWidth + Theme.spacingMd * 2
        implicitHeight: chipLabel.implicitHeight + Theme.spacingSm
        radius: Theme.radiusPill
        color: Theme.withAlpha(Theme.surface, 0.7)
        border.color: Theme.border
        border.width: 1
        Label {
            id: chipLabel
            anchors.centerIn: parent
            color: Theme.subtext
            font.pixelSize: Theme.fontCaption
        }
    }

    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop { position: 0.0; color: Theme.withAlpha(Theme.background, 0.85) }
            GradientStop { position: 1.0; color: "transparent" }
        }
    }

    // Absorb clicks so they don't reach the play/pause layer beneath.
    MouseArea { anchors.fill: parent }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: Theme.spacingLg
        anchors.rightMargin: Theme.spacingLg
        spacing: Theme.spacingMd

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 0
            Label {
                text: app.mediaName.length > 0 ? app.mediaName
                      : (app.isHost ? "No file shared yet" : "Waiting for host…")
                color: Theme.text
                font.pixelSize: Theme.fontSubtitle
                font.weight: Font.DemiBold
                elide: Text.ElideRight
                Layout.fillWidth: true
            }
            Label {
                text: app.isHost ? "You are hosting" : "Connected to host"
                color: Theme.subtext
                font.pixelSize: Theme.fontCaption
            }
        }

        Row {
            spacing: Theme.spacingSm
            visible: app.hasMedia
            Layout.alignment: Qt.AlignVCenter

            Chip { text: app.peers + (app.peers === 1 ? " peer" : " peers") }
            Chip { text: "\u2193 " + app.downRateText }
            Chip { text: "\u2191 " + app.upRateText }
        }

        IconButton {
            name: "options"
            text: "Settings"
            onClicked: ApplicationWindow.window.openSettings()
        }

        IconButton {
            name: "leave"
            iconColor: Theme.subtext
            hoverColor: Theme.danger
            text: "Leave room"
            onClicked: app.leave()
        }
    }
}
