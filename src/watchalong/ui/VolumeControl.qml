import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Mute toggle + inline volume slider, bound to app.volume / app.setVolume.
RowLayout {
    id: vol
    spacing: Theme.spacingXs

    property int lastNonZero: 100

    IconButton {
        name: app.volume === 0 ? "mute" : "volume"
        iconColor: Theme.subtext
        hoverColor: Theme.text
        text: app.volume === 0 ? "Unmute" : "Mute"
        onClicked: {
            if (app.volume === 0)
                app.setVolume(vol.lastNonZero);
            else {
                vol.lastNonZero = app.volume;
                app.setVolume(0);
            }
        }
    }

    Slider {
        id: slider
        Layout.preferredWidth: 80
        visible: vol.parent.width >= 700
        from: 0
        to: 100
        value: app.volume
        onMoved: {
            app.setVolume(value);
            if (value > 0)
                vol.lastNonZero = value;
        }
    }
}
