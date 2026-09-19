import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

ApplicationWindow {
    id: win
    width: 440
    height: 220
    visible: true
    title: "Updating Koodaamo Watchalong"
    color: Theme.background

    Material.theme: Material.Dark
    Material.accent: Theme.accent
    Material.primary: Theme.accent
    Material.background: Theme.surface
    Material.foreground: Theme.text

    ColumnLayout {
        anchors.centerIn: parent
        width: parent.width - Theme.spacingXxl * 2
        spacing: Theme.spacingLg

        Label {
            Layout.alignment: Qt.AlignHCenter
            text: "Koodaamo Watchalong"
            color: Theme.text
            font.pixelSize: Theme.fontTitle
            font.weight: Font.DemiBold
        }
        Label {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            text: updater.statusText
            color: Theme.subtext
            font.pixelSize: Theme.fontBody
        }
        ProgressBar {
            Layout.fillWidth: true
            from: 0
            to: 1
            value: updater.progress
            indeterminate: updater.progress <= 0
        }
    }
}
