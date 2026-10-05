import QtQuick
import QtQuick.Controls

Item {
    id: spinner
    property bool running: true
    implicitWidth: 48
    implicitHeight: 48
    visible: running
    ToolButton {
        id: glyph
        anchors.fill: parent
        display: AbstractButton.IconOnly
        icon.source: "icons/loader-circle.svg"
        icon.color: Theme.accent
        icon.width: 32
        icon.height: 32
        background: null
        enabled: false
        Accessible.ignored: true
        RotationAnimator { target: glyph; from: 0; to: 360; duration: 900; loops: Animation.Infinite; running: spinner.running && spinner.visible }
    }
}