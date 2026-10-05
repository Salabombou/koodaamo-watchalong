import QtQuick
import QtQuick.Controls

ToolButton {
    id: control

    property string name: ""
    property int iconSize: 22
    property color iconColor: Theme.text
    property color hoverColor: Theme.text
    property color activeColor: Theme.accent
    property bool active: false

    readonly property color effectiveColor: !enabled ? Theme.faint
                                             : active ? activeColor
                                             : hovered ? hoverColor
                                             : iconColor

    implicitWidth: 40
    implicitHeight: 40
    hoverEnabled: true
    opacity: enabled ? 1.0 : 0.4
    display: AbstractButton.IconOnly
    icon.width: iconSize
    icon.height: iconSize
    icon.color: effectiveColor
    icon.source: "icons/" + ({play: "play", pause: "pause", back10: "rewind",
        forward10: "fast-forward", volume: "volume-2", mute: "volume-x",
        fullscreen: "maximize", fullscreenExit: "minimize", share: "upload",
        options: "settings", leave: "log-out", check: "check", users: "users",
        more: "ellipsis", close: "x", download: "download", edit: "pencil", film: "film",
        shuffle: "shuffle", back: "arrow-left"}[name] || "settings") + ".svg"
    Accessible.name: text
    onClicked: Sounds.click()

    background: Rectangle {
        radius: Theme.radiusPill
        color: Theme.withAlpha(Theme.text, control.pressed ? 0.18 : control.hovered ? 0.10 : 0.0)
        Behavior on color { ColorAnimation { duration: Theme.durFast } }
    }

    ToolTip.visible: hovered && text.length > 0
    ToolTip.text: text
    ToolTip.delay: 500
}
