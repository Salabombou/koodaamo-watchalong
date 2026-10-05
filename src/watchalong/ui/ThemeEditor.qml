import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs

Dialog {
    id: editor
    objectName: "themeEditor"
    property var document: ({})
    property string selectedToken: ""
    modal: true
    title: "Custom theme"
    width: Math.min(560, parent.width - 32)
    height: Math.min(640, parent.height - 32)
    anchors.centerIn: parent
    padding: 20
    standardButtons: Dialog.NoButton

    function edit(name, duplicate) {
        document = preferences.themeDocument(name);
        document.name = duplicate ? "My theme" : name;
        nameField.text = document.name;
        darkControl.checked = document.isDark;
        open();
    }
    function setColor(token, value) {
        var next = JSON.parse(JSON.stringify(document));
        next.colors[token] = value;
        document = next;
    }

    ColorDialog {
        id: picker
        onAccepted: editor.setColor(editor.selectedToken, selectedColor.toString())
    }

    contentItem: ColumnLayout {
        spacing: 12
        TextField {
            id: nameField
            Layout.fillWidth: true
            placeholderText: "Theme name"
            maximumLength: 32
            Accessible.name: "Theme name"
        }
        Switch { id: darkControl; text: "Dark control style" }
        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            ColumnLayout {
                width: editor.availableWidth - 16
                spacing: 6
                Repeater {
                    model: preferences.colorFields
                    delegate: RowLayout {
                        required property string modelData
                        Layout.fillWidth: true
                        Label { text: modelData; Layout.fillWidth: true; color: Theme.subtext }
                        AbstractButton {
                            implicitWidth: 36
                            implicitHeight: 36
                            Accessible.name: "Choose " + modelData + " color"
                            background: Rectangle {
                                radius: 4
                                color: editor.document.colors ? editor.document.colors[modelData] : "transparent"
                                border.color: Theme.border
                            }
                            onClicked: {
                                editor.selectedToken = modelData;
                                picker.selectedColor = editor.document.colors[modelData];
                                picker.open();
                            }
                        }
                        TextField {
                            Layout.preferredWidth: 126
                            text: editor.document.colors ? editor.document.colors[modelData] : ""
                            maximumLength: 9
                            Accessible.name: modelData + " hex color"
                            onEditingFinished: editor.setColor(modelData, text)
                        }
                    }
                }
            }
        }
        RowLayout {
            Layout.fillWidth: true
            Item { Layout.fillWidth: true }
            Button { text: "Cancel"; onClicked: editor.close() }
            Button {
                text: "Save theme"
                highlighted: true
                enabled: nameField.text.trim().length > 0
                onClicked: {
                    var next = JSON.parse(JSON.stringify(editor.document));
                    next.name = nameField.text.trim();
                    next.isDark = darkControl.checked;
                    if (preferences.saveTheme(next))
                        editor.close();
                }
            }
        }
    }
}