import QtQuick
import QtQuick.Controls

Item {
    id: hold
    property int holdDuration: 1200
    property int acceptedButtons: Qt.LeftButton | Qt.RightButton
    property color progressColor: Theme.danger
    property real progress: 0
    property bool holding: false
    property bool completed: false
    property int pressedButton: Qt.LeftButton
    property string accessibleText: ""
    readonly property bool hovered: mouse.containsMouse
    signal clicked(int button)
    signal held(int button)
    activeFocusOnTab: true
    Accessible.role: Accessible.Button
    Accessible.name: accessibleText

    function begin(button) {
        if (!enabled || holding) return;
        forceActiveFocus();
        pressedButton = button;
        completed = false;
        holding = true;
        progress = 0;
        fill.restart();
    }
    function cancel() {
        fill.stop();
        holding = false;
        progress = 0;
    }
    function release() {
        var quickClick = holding && !completed && progress * holdDuration < 250;
        var button = pressedButton;
        cancel();
        if (quickClick) clicked(button);
    }
    onEnabledChanged: if (!enabled) cancel()
    onVisibleChanged: if (!visible) cancel()
    onActiveFocusChanged: if (!activeFocus) cancel()
    Keys.onPressed: (event) => {
        if ((event.key === Qt.Key_Space || event.key === Qt.Key_Return) && !event.isAutoRepeat) {
            begin(Qt.LeftButton);
            event.accepted = true;
        }
    }
    Keys.onReleased: (event) => {
        if ((event.key === Qt.Key_Space || event.key === Qt.Key_Return) && !event.isAutoRepeat) {
            release();
            event.accepted = true;
        }
    }
    NumberAnimation {
        id: fill
        target: hold
        property: "progress"
        from: 0
        to: 1
        duration: hold.holdDuration
        onFinished: {
            if (hold.holding && hold.enabled) {
                hold.completed = true;
                hold.held(hold.pressedButton);
            }
        }
    }
    Rectangle {
        anchors.left: parent.left
        anchors.bottom: parent.bottom
        width: parent.width * hold.progress
        height: 4
        color: hold.progressColor
        visible: hold.holding
    }
    Rectangle {
        anchors.fill: parent
        color: "transparent"
        border.color: Theme.accent
        border.width: hold.activeFocus ? 2 : 0
        radius: 4
    }
    MouseArea {
        id: mouse
        anchors.fill: parent
        acceptedButtons: hold.acceptedButtons
        hoverEnabled: true
        preventStealing: true
        onPressed: (event) => hold.begin(event.button)
        onReleased: hold.release()
        onCanceled: hold.cancel()
        onExited: if (pressed) hold.cancel()
    }
}