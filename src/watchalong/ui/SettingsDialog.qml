import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs

Dialog {
    id: settingsDialog
    objectName: "settingsDialog"
    property bool firstRun: !preferences.firstRunDone
    property string browseTarget: ""
    property string themeName: "Dark"
    readonly property string selectedPlayer: playerChoice.currentValue || "builtin"
    readonly property bool valid: usernameField.text.trim().length > 0
                                 && preferences.validateExecutable(mpvPath.text)
                                 && preferences.validateExecutable(vlcPath.text)
                                 && preferences.validatePlayer(selectedPlayer, selectedPlayer === "mpv" ? mpvPath.text : selectedPlayer === "vlc" ? vlcPath.text : "")
    modal: true
    title: firstRun ? "Set up Watchalong" : "Settings"
    anchors.centerIn: parent
    width: Math.min(650, parent.width - 32)
    height: Math.min(640, parent.height - 32)
    padding: 20
    closePolicy: firstRun ? Popup.NoAutoClose : Popup.CloseOnEscape
    onOpened: {
        var values = preferences.values;
        usernameField.text = values.username;
        mpvPath.text = values.mpvPath || (firstRun ? preferences.detectedPaths.mpv : "");
        vlcPath.text = values.vlcPath || (firstRun ? preferences.detectedPaths.vlc : "");
        playerChoice.currentIndex = playerChoice.indexOfValue(values.defaultPlayer);
        themeName = values.themeName;
        soundEnabled.checked = values.soundsEnabled;
        soundVolume.value = values.soundVolume;
        reduceMotion.checked = values.reduceMotion;
        tabs.currentIndex = 0;
    }
    onClosed: preferences.cancelPreview()

    FileDialog {
        id: executablePicker
        title: "Select player executable"
        nameFilters: ["Executables (*.exe *.com)", "All files (*)"]
        onAccepted: {
            var path = preferences.normalizePath(selectedFile.toString());
            if (settingsDialog.browseTarget === "mpv") mpvPath.text = path;
            else vlcPath.text = path;
        }
    }
    FileDialog {
        id: importPicker
        title: "Import theme"
        nameFilters: ["Watchalong theme (*.json)"]
        onAccepted: {
            if (preferences.importTheme(selectedFile.toString()))
                settingsDialog.themeName = preferences.values.themeName;
        }
    }
    FileDialog {
        id: exportPicker
        title: "Export theme"
        fileMode: FileDialog.SaveFile
        defaultSuffix: "watchalong-theme.json"
        nameFilters: ["Watchalong theme (*.json)"]
        onAccepted: preferences.exportTheme(settingsDialog.themeName, selectedFile.toString())
    }
    ThemeEditor { id: themeEditor; onClosed: settingsDialog.themeName = preferences.values.themeName }
    Dialog {
        id: deleteDialog
        title: "Delete " + settingsDialog.themeName + "?"
        anchors.centerIn: parent
        modal: true
        standardButtons: Dialog.Cancel | Dialog.Ok
        onAccepted: {
            preferences.removeTheme(settingsDialog.themeName);
            settingsDialog.themeName = preferences.values.themeName;
        }
    }

    contentItem: ColumnLayout {
        spacing: 16
        TabBar {
            id: tabs
            Layout.fillWidth: true
            TabButton { text: "Profile" }
            TabButton { text: "Players" }
            TabButton { text: "Appearance" }
            TabButton { text: "Sound" }
        }
        StackLayout {
            currentIndex: tabs.currentIndex
            Layout.fillWidth: true
            Layout.fillHeight: true
            ScrollView {
                clip: true
                ColumnLayout {
                    width: settingsDialog.availableWidth - 16
                    spacing: 12
                    Label { text: "Username"; color: Theme.subtext }
                    TextField {
                        id: usernameField
                        objectName: "usernameField"
                        Layout.fillWidth: true
                        placeholderText: "Your name"
                        maximumLength: 24
                        selectByMouse: true
                        Accessible.name: "Username"
                    }
                    Label {
                        visible: preferences.loadError.length > 0
                        text: preferences.loadError
                        textFormat: Text.PlainText
                        wrapMode: Text.WordWrap
                        Layout.fillWidth: true
                        color: Theme.warning
                    }
                }
            }
            ScrollView {
                clip: true
                ColumnLayout {
                    width: settingsDialog.availableWidth - 16
                    spacing: 10
                    Label { text: "Preferred player"; color: Theme.subtext }
                    ComboBox {
                        id: playerChoice
                        Layout.fillWidth: true
                        model: [{key: "builtin", label: "Built-in"}, {key: "mpv", label: "mpv"}, {key: "vlc", label: "VLC"}]
                        textRole: "label"
                        valueRole: "key"
                    }
                    Label { text: "mpv executable"; color: Theme.subtext }
                    RowLayout {
                        Layout.fillWidth: true
                        TextField { id: mpvPath; Layout.fillWidth: true; placeholderText: "Auto-detect"; selectByMouse: true; Accessible.name: "mpv executable" }
                        Button { text: "Browse"; onClicked: { settingsDialog.browseTarget = "mpv"; executablePicker.open(); } }
                    }
                    Label { visible: !preferences.validateExecutable(mpvPath.text); text: "Executable not found"; color: Theme.danger }
                    Label { text: "VLC executable"; color: Theme.subtext }
                    RowLayout {
                        Layout.fillWidth: true
                        TextField { id: vlcPath; Layout.fillWidth: true; placeholderText: "Auto-detect"; selectByMouse: true; Accessible.name: "VLC executable" }
                        Button { text: "Browse"; onClicked: { settingsDialog.browseTarget = "vlc"; executablePicker.open(); } }
                    }
                    Label { visible: !preferences.validateExecutable(vlcPath.text); text: "Executable not found"; color: Theme.danger }
                    Label {
                        visible: !preferences.validatePlayer(settingsDialog.selectedPlayer, settingsDialog.selectedPlayer === "mpv" ? mpvPath.text : settingsDialog.selectedPlayer === "vlc" ? vlcPath.text : "")
                        text: "Selected player is unavailable"
                        color: Theme.danger
                    }
                }
            }
            ScrollView {
                clip: true
                ColumnLayout {
                    width: settingsDialog.availableWidth - 16
                    spacing: 12
                    Label { text: "Theme"; color: Theme.subtext }
                    Repeater {
                        model: preferences.availableThemes
                        delegate: RadioButton {
                            required property var modelData
                            text: modelData.name
                            checked: settingsDialog.themeName === modelData.name
                            onClicked: {
                                settingsDialog.themeName = modelData.name;
                                preferences.previewTheme(modelData.name);
                            }
                        }
                    }
                    Flow {
                        Layout.fillWidth: true
                        spacing: 8
                        Button { text: "Create"; onClicked: themeEditor.edit(settingsDialog.themeName, true) }
                        Button { text: "Edit"; enabled: settingsDialog.themeName !== "Dark" && settingsDialog.themeName !== "Light"; onClicked: themeEditor.edit(settingsDialog.themeName, false) }
                        Button { text: "Delete"; enabled: settingsDialog.themeName !== "Dark" && settingsDialog.themeName !== "Light"; onClicked: deleteDialog.open() }
                        Button { text: "Import"; onClicked: importPicker.open() }
                        Button { text: "Export"; onClicked: exportPicker.open() }
                    }
                    Repeater {
                        model: preferences.contrastWarnings
                        delegate: Label {
                            required property string modelData
                            text: modelData
                            color: Theme.warning
                            wrapMode: Text.WordWrap
                            Layout.fillWidth: true
                        }
                    }
                    Switch { id: reduceMotion; text: "Reduce motion" }
                }
            }
            ColumnLayout {
                spacing: 12
                Switch { id: soundEnabled; text: "Interface sounds" }
                Label { text: "Sound volume"; color: Theme.subtext }
                Slider { id: soundVolume; from: 0; to: 100; enabled: soundEnabled.checked; Layout.fillWidth: true; Accessible.name: "Interface sound volume" }
                Item { Layout.fillHeight: true }
            }
        }
        RowLayout {
            Layout.fillWidth: true
            Label {
                visible: !settingsDialog.valid
                text: usernameField.text.trim().length === 0 ? "Enter a username" : "Check player settings"
                color: Theme.warning
                Layout.fillWidth: true
                wrapMode: Text.WordWrap
            }
            Item { Layout.fillWidth: true }
            Button {
                text: settingsDialog.firstRun ? "Exit" : "Cancel"
                onClicked: settingsDialog.firstRun ? Qt.quit() : settingsDialog.close()
            }
            Button {
                objectName: "saveSettingsButton"
                text: settingsDialog.firstRun && tabs.currentIndex < 3 ? "Next" : settingsDialog.firstRun ? "Start watching" : "Save"
                highlighted: true
                enabled: settingsDialog.valid
                onClicked: {
                    if (settingsDialog.firstRun && tabs.currentIndex < 3) { tabs.currentIndex++; return; }
                    if (preferences.save({username: usernameField.text, mpvPath: mpvPath.text, vlcPath: vlcPath.text,
                                          defaultPlayer: settingsDialog.selectedPlayer, themeName: settingsDialog.themeName,
                                          soundsEnabled: soundEnabled.checked, soundVolume: soundVolume.value,
                                          reduceMotion: reduceMotion.checked}, settingsDialog.firstRun))
                        settingsDialog.close();
                }
            }
        }
    }
}