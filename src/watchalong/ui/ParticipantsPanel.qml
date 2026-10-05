import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Rectangle {
    id: panel
    objectName: "participantsPanel"
    color: Theme.surface
    property string targetId: ""
    property string targetName: ""
    property bool targetIgnored: false
    property bool targetLoaded: false
    property bool kickConfirmation: false
    Connections {
        target: app
        function onChanged() { if (!app.isHost || app.transferring) confirmation.close(); }
    }
    Connections {
        target: app.participants
        function onRowsRemoved() { confirmation.close(); }
        function onModelReset() { confirmation.close(); }
    }

    function confirm(peerId, displayName, kick) {
        targetId = peerId;
        targetName = displayName;
        kickConfirmation = kick;
        confirmation.open();
    }
    Dialog {
        id: confirmation
        objectName: "moderationConfirmation"
        parent: Overlay.overlay
        anchors.centerIn: parent
        width: Math.min(420, parent.width - 32)
        padding: 24
        background: Rectangle { color: Theme.surface; radius: 8; border.color: Theme.border }
        header: Label { text: confirmation.title; color: Theme.text; font.pixelSize: 22; padding: 24; bottomPadding: 12 }
        Overlay.modal: Rectangle { color: Theme.overlayScrim }
        modal: true
        closePolicy: Popup.CloseOnEscape
        title: panel.kickConfirmation ? "Remove participant?" : "Transfer hosting?"
        onClosed: confirmHold.cancel()
        contentItem: ColumnLayout {
            spacing: 20
            Label {
                text: panel.targetName
                textFormat: Text.PlainText
                wrapMode: Text.WrapAnywhere
                Layout.fillWidth: true
                color: Theme.text
                font.pixelSize: Theme.fontSubtitle
            }
            RowLayout {
                Layout.fillWidth: true
                Button { text: "Cancel"; onClicked: confirmation.close() }
                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: 48
                    radius: 4
                    color: panel.kickConfirmation ? Theme.danger : Theme.accent
                    Label {
                        anchors.centerIn: parent
                        text: panel.kickConfirmation ? "Hold to remove" : "Hold to transfer"
                        color: Theme.background
                        font.weight: Font.DemiBold
                    }
                    HoldArea {
                        id: confirmHold
                        objectName: "confirmHold"
                        anchors.fill: parent
                        holdDuration: 1500
                        acceptedButtons: Qt.LeftButton
                        progressColor: Theme.text
                        accessibleText: panel.kickConfirmation ? "Hold to remove participant" : "Hold to transfer hosting"
                        enabled: app.isHost && !app.transferring
                        onHeld: {
                            Sounds.ready();
                            if (panel.kickConfirmation) app.kick(panel.targetId);
                            else app.transferHost(panel.targetId);
                            confirmation.close();
                        }
                    }
                }
            }
        }
    }
    Menu {
        id: actions
        MenuItem { text: panel.targetIgnored ? "Stop ignoring" : "Ignore"; onTriggered: app.setIgnored(panel.targetId, !panel.targetIgnored) }
        MenuItem { text: "Remove participant..."; onTriggered: panel.confirm(panel.targetId, panel.targetName, true) }
        MenuItem { text: "Transfer hosting..."; enabled: panel.targetLoaded && !panel.targetIgnored; onTriggered: panel.confirm(panel.targetId, panel.targetName, false) }
    }
    ColumnLayout {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 16
        RowLayout {
            Layout.fillWidth: true
            Label { text: "Room"; color: Theme.text; font.pixelSize: Theme.fontTitle; font.weight: Font.DemiBold; Layout.fillWidth: true }
            Label { text: app.readyCount + "/" + app.requiredCount + " ready"; color: Theme.subtext; font.pixelSize: Theme.fontCaption }
        }
        Label {
            text: app.roomCode
            textFormat: Text.PlainText
            color: Theme.subtext
            elide: Text.ElideRight
            Layout.fillWidth: true
        }
        Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: Theme.border }
        ListView {
            id: members
            objectName: "participantsList"
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: 4
            model: app.participants
            delegate: Rectangle {
                id: member
                required property string peerId
                required property string displayName
                required property bool ready
                required property bool loaded
                required property bool ignored
                required property bool participating
                required property bool isHost
                required property bool isSelf
                width: members.width
                height: 66
                radius: 4
                color: rowHold.hovered ? Theme.surfaceHover : "transparent"
                opacity: ignored ? 0.65 : 1
                RowLayout {
                    anchors.fill: parent
                    anchors.margins: 8
                    anchors.rightMargin: menuButton.visible ? 36 : 8
                    spacing: 10
                    Rectangle {
                        implicitWidth: 32
                        implicitHeight: 32
                        radius: 4
                        color: Theme.surfaceElevated
                        Label { anchors.centerIn: parent; text: member.displayName.charAt(0).toUpperCase(); textFormat: Text.PlainText; color: Theme.text; font.weight: Font.DemiBold }
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 3
                        Label {
                            text: member.displayName + (member.isSelf ? " (you)" : "")
                            textFormat: Text.PlainText
                            color: Theme.text
                            elide: Text.ElideRight
                            Layout.fillWidth: true
                            font.weight: member.isHost ? Font.DemiBold : Font.Normal
                        }
                        RowLayout {
                            spacing: 6
                            Rectangle { implicitWidth: 6; implicitHeight: 6; radius: 3; color: member.ignored ? Theme.faint : member.ready ? Theme.success : member.loaded ? Theme.faint : Theme.warning }
                            Label { text: member.ignored ? "Ignored" : member.ready ? "Ready" : member.loaded ? "Not ready" : "Loading"; color: Theme.subtext; font.pixelSize: Theme.fontCaption }
                            Label { text: member.isHost ? "Host" : ""; color: Theme.accent; font.pixelSize: Theme.fontCaption }
                        }
                    }
                }
                HoldArea {
                    id: rowHold
                    objectName: "participantHold_" + member.peerId
                    anchors.fill: parent
                    enabled: app.isHost && !member.isSelf && !app.transferring
                    accessibleText: "Participant " + member.displayName
                    progressColor: pressedButton === Qt.RightButton ? Theme.accent : Theme.danger
                    onClicked: (button) => {
                        if (button === Qt.LeftButton) app.setIgnored(member.peerId, !member.ignored);
                        else menuButton.clicked();
                    }
                    onHeld: (button) => {
                        Sounds.ready();
                        if (button === Qt.LeftButton) app.kick(member.peerId);
                        else if (member.loaded && !member.ignored) panel.confirm(member.peerId, member.displayName, false);
                    }
                    ToolTip.visible: hovered && visible && enabled && panel.visible
                    ToolTip.text: "Click: ignore. Hold left: remove. Hold right: transfer."
                    ToolTip.delay: 700
                }
                IconButton {
                    id: menuButton
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    name: "more"
                    text: "Participant actions"
                    visible: app.isHost && !member.isSelf
                    width: 28
                    height: 36
                    onClicked: {
                        panel.targetId = member.peerId;
                        panel.targetName = member.displayName;
                        panel.targetIgnored = member.ignored;
                        panel.targetLoaded = member.loaded;
                        actions.popup(menuButton);
                    }
                }
            }
            ScrollBar.vertical: ScrollBar {}
        }
        LoadingSpinner { running: app.transferring; Layout.alignment: Qt.AlignHCenter; implicitWidth: 24; implicitHeight: 24 }
        Label { visible: app.transferring; text: "Transferring hosting..."; color: Theme.subtext; Layout.fillWidth: true; wrapMode: Text.WordWrap }
    }
}