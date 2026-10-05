import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Top gradient overlay: media title on the left, live P2P stats + leave on the right.
Item {
    id: topBar
    implicitHeight: 64
    signal participantsRequested()

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
        color: Theme.surface
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
            Layout.minimumWidth: 0
            spacing: 0
            Label {
                text: app.mediaName.length > 0 ? app.mediaName
                      : (app.isHost ? "No file shared yet" : "Waiting for host…")
                    textFormat: Text.PlainText
                color: Theme.text
                font.pixelSize: Theme.fontSubtitle
                font.weight: Font.DemiBold
                elide: Text.ElideRight
                Layout.fillWidth: true
                Layout.minimumWidth: 0
            }
            Label {
                    text: app.phase === "countdown" ? "Starting together..."
                        : app.playing ? "Playing together" : app.readyCount + "/" + app.requiredCount + " ready"
                color: Theme.subtext
                font.pixelSize: Theme.fontCaption
            }
        }

        Row {
            spacing: Theme.spacingSm
            visible: app.hasMedia && topBar.width >= 1050
            Layout.alignment: Qt.AlignVCenter

            Chip { text: app.peers + (app.peers === 1 ? " peer" : " peers") }
            Chip { text: "\u2193 " + app.downRateText }
            Chip { text: "\u2191 " + app.upRateText }
        }

        IconButton {
            name: "users"
            text: "Participants"
            onClicked: topBar.participantsRequested()
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
