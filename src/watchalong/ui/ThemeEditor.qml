import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs

Dialog {
    id: editor
    objectName: "themeEditor"
    property var document: ({})
    property string selectedToken: ""
    property var imageCandidates: []
    property var randomCandidates: []
    property var colorCandidates: []
    property var randomHistory: []
    property var generatedCandidate: ({})
    property string imageThumbnail: ""
    property string selectedSeed: ""
    property string draftError: ""
    property string pendingKind: ""
    property int pendingMode: 0
    property string pendingSeed: ""
    property var replacementAction: null
    property bool manualDirty: false
    property bool initializing: false
    property bool closing: false
    property int appliedStyleIndex: 0
    readonly property bool compact: parent.height < 600
    readonly property bool darkMode: modeChoice.currentIndex === 0
    readonly property bool imageReady: sourceThumbnail.status === Image.Ready
    readonly property string style: styleChoice.currentValue || "balanced"
    signal saved()
    modal: true
    parent: Overlay.overlay
    title: "Custom theme"
    width: Math.min(620, parent.width - 32)
    height: Math.min(720, parent.height - 32)
    anchors.centerIn: parent
    padding: compact ? 12 : 20
    background: Rectangle { color: Theme.surface; radius: 8; border.color: Theme.border }
    header: Label { text: editor.title; color: Theme.text; font.pixelSize: 22; padding: editor.compact ? 12 : 20; bottomPadding: 8 }
    Overlay.modal: Rectangle { color: Theme.overlayScrim }
    standardButtons: Dialog.NoButton
    closePolicy: Popup.CloseOnEscape
    onAboutToHide: {
        closing = true;
        replacementAction = null;
        colorDebounce.stop();
        picker.close();
        sourcePicker.close();
        imagePicker.close();
        replaceDialog.close();
        themeGenerator.cancel();
    }

    function edit(name, duplicate) {
        themeGenerator.cancel();
        initializing = true;
        closing = false;
        document = preferences.themeDocument(name);
        var available = preferences.availableThemes.map(function(entry) { return entry.name.toLowerCase(); });
        var freshName = "My theme";
        var suffix = 2;
        while (available.indexOf(freshName.toLowerCase()) !== -1) freshName = "My theme (" + suffix++ + ")";
        document.name = duplicate ? freshName : name;
        nameField.text = document.name;
        modeChoice.currentIndex = document.isDark ? 0 : 1;
        styleChoice.currentIndex = 0;
        appliedStyleIndex = 0;
        tabs.currentIndex = duplicate ? 0 : 3;
        colorField.text = "#" + document.colors.accent.slice(-6);
        imageCandidates = [];
        randomCandidates = [];
        colorCandidates = [];
        randomHistory = [];
        imageThumbnail = "";
        generatedCandidate = ({});
        selectedSeed = "";
        draftError = "";
        pendingKind = "";
        manualDirty = false;
        initializing = false;
        open();
        preview();
    }

    function setColor(token, value) {
        if (!visible || closing) return;
        if (document.colors[token] === value.toUpperCase()) {
            draftError = "";
            return;
        }
        var next = JSON.parse(JSON.stringify(document));
        next.colors[token] = value;
        if (!preferences.previewDocument(next)) {
            draftError = "Use #RRGGBB or #AARRGGBB colors";
            return;
        }
        themeGenerator.cancel();
        document = next;
        generatedCandidate = ({});
        manualDirty = true;
        draftError = "";
        preview();
    }

    function preview() {
        var next = JSON.parse(JSON.stringify(document));
        next.isDark = modeChoice.currentIndex === 0;
        preferences.previewDocument(next);
    }

    function replaceDraft(action) {
        if (!visible || closing) return;
        draftError = "";
        if (manualDirty) {
            replacementAction = action;
            replaceDialog.open();
        } else {
            action();
        }
    }

    function applyCandidate(candidate, isDark) {
        themeGenerator.cancel();
        var name = document.name;
        var useDark = isDark === undefined ? modeChoice.currentIndex === 0 : isDark;
        generatedCandidate = candidate;
        document = JSON.parse(JSON.stringify(candidate[useDark ? "dark" : "light"]));
        document.name = name;
        selectedSeed = candidate.seed;
        manualDirty = false;
        styleChoice.currentIndex = styleChoice.indexOfValue(candidate.style);
        appliedStyleIndex = styleChoice.currentIndex;
        preview();
    }

    function chooseCandidate(candidate) {
        replaceDraft(function() { editor.applyCandidate(candidate); });
    }

    function generateImage(path) {
        replaceDraft(function() {
            editor.pendingKind = "image";
            editor.pendingMode = 0;
            editor.pendingSeed = "";
            themeGenerator.requestImage(path, editor.style);
        });
    }

    function shuffle() {
        replaceDraft(function() {
            editor.pendingKind = "random";
            editor.pendingMode = 1;
            editor.pendingSeed = "";
            themeGenerator.requestRandom(editor.style);
        });
    }

    function previousBatch() {
        if (!randomHistory.length) return;
        replaceDraft(function() {
            var history = editor.randomHistory.slice();
            var previous = history.pop();
            editor.randomHistory = history;
            editor.randomCandidates = previous;
            editor.applyCandidate(previous[0]);
        });
    }

    function generateColor(color) {
        colorDebounce.stop();
        colorField.text = color;
        replaceDraft(function() {
            editor.pendingKind = "color";
            editor.pendingMode = 2;
            editor.pendingSeed = "";
            themeGenerator.requestColor(color, editor.style);
        });
    }

    function regenerate() {
        var candidates = tabs.currentIndex === 0 ? imageCandidates : tabs.currentIndex === 1 ? randomCandidates : colorCandidates;
        if (!candidates.length) return;
        replaceDraft(function() {
            editor.pendingKind = "refresh";
            editor.pendingMode = tabs.currentIndex;
            editor.pendingSeed = editor.selectedSeed;
            themeGenerator.requestSeeds(candidates, editor.style);
        });
    }

    Connections {
        target: themeGenerator
        function onResultReady(result) {
            if (!editor.visible || editor.closing || !result.candidates.length) return;
            if (editor.pendingMode === 0) {
                editor.imageCandidates = result.candidates;
                if (result.thumbnail) editor.imageThumbnail = result.thumbnail;
            } else if (editor.pendingMode === 1) {
                if (editor.pendingKind === "random" && editor.randomCandidates.length)
                    editor.randomHistory = editor.randomHistory.concat([editor.randomCandidates]).slice(-8);
                editor.randomCandidates = result.candidates;
            } else {
                editor.colorCandidates = result.candidates;
            }
            var selected = result.candidates[0];
            for (var index = 0; index < result.candidates.length; index++)
                if (result.candidates[index].seed === editor.pendingSeed) selected = result.candidates[index];
            editor.applyCandidate(selected);
            editor.pendingKind = "";
        }
    }

    Connections {
        target: preferences
        function onErrorOccurred(message) { if (editor.visible) editor.draftError = message; }
    }

    FileDialog {
        id: imagePicker
        title: "Choose a theme image"
        nameFilters: ["Images (*.png *.jpg *.jpeg *.webp *.bmp *.gif)"]
        onAccepted: editor.generateImage(selectedFile.toString())
    }

    Timer {
        id: colorDebounce
        interval: 300
        onTriggered: {
            if (editor.visible && !editor.closing && tabs.currentIndex === 2 && !themeGenerator.busy
                    && /^#[0-9a-fA-F]{6}$/.test(colorField.text)) editor.generateColor(colorField.text);
        }
    }

    ColorDialog {
        id: picker
        onAccepted: editor.setColor(editor.selectedToken, selectedColor.toString())
    }

    ColorDialog {
        id: sourcePicker
        onAccepted: editor.generateColor("#" + selectedColor.toString().slice(-6))
    }

    Dialog {
        id: replaceDialog
        objectName: "replaceThemeDraft"
        title: "Replace edited colors?"
        modal: true
        anchors.centerIn: parent
        standardButtons: Dialog.Cancel | Dialog.Ok
        background: Rectangle { color: Theme.surface; radius: 8; border.color: Theme.border }
        onAccepted: {
            var action = editor.replacementAction;
            editor.replacementAction = null;
            if (action) action();
        }
        onRejected: {
            editor.replacementAction = null;
            editor.initializing = true;
            modeChoice.currentIndex = editor.document.isDark ? 0 : 1;
            styleChoice.currentIndex = editor.appliedStyleIndex;
            editor.initializing = false;
        }
    }

    contentItem: ColumnLayout {
        spacing: 8
        RowLayout {
            Layout.fillWidth: true
            TextField {
                id: nameField
                objectName: "themeNameField"
                Layout.fillWidth: true
                Layout.preferredHeight: editor.compact ? 44 : implicitHeight
                placeholderText: "Theme name"
                maximumLength: 32
                Accessible.name: "Theme name"
                onTextEdited: {
                    if (editor.draftError !== "Use #RRGGBB or #AARRGGBB colors") editor.draftError = "";
                }
            }
            ComboBox {
                id: styleChoice
                objectName: "themeStyleChoice"
                Layout.preferredWidth: 150
                Layout.preferredHeight: editor.compact ? 44 : implicitHeight
                visible: tabs.currentIndex !== 3
                enabled: !themeGenerator.busy
                textRole: "label"
                valueRole: "value"
                model: [{label: "Balanced", value: "balanced"}, {label: "Vivid", value: "vivid"},
                        {label: "Expressive", value: "expressive"}, {label: "Muted", value: "muted"}]
                Accessible.name: "Palette style"
                onActivated: editor.regenerate()
            }
        }
        TabBar {
            id: tabs
            objectName: "themeCreationTabs"
            Layout.fillWidth: true
            Layout.preferredHeight: 40
            enabled: !themeGenerator.busy
            TabButton { text: "Image" }
            TabButton { text: "Random" }
            TabButton { text: "Color" }
            TabButton { text: "Manual" }
        }
        ScrollView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            ColumnLayout {
                width: editor.availableWidth - 16
                spacing: 10
                ColumnLayout {
                    visible: tabs.currentIndex === 0
                    Layout.fillWidth: true
                    RowLayout {
                        Layout.fillWidth: true
                        Image {
                            id: sourceThumbnail
                            objectName: "themeSourceThumbnail"
                            visible: editor.imageThumbnail.length > 0
                            source: editor.imageThumbnail
                            Layout.preferredWidth: editor.compact ? 80 : 128
                            Layout.preferredHeight: editor.compact ? 80 : 128
                            fillMode: Image.PreserveAspectFit
                        }
                        Button { text: "Choose image"; enabled: !themeGenerator.busy; onClicked: imagePicker.open() }
                        Item { Layout.fillWidth: true }
                    }
                    Flow {
                        Layout.fillWidth: true
                        spacing: 8
                        Repeater {
                            model: editor.imageCandidates
                            delegate: AbstractButton {
                                required property var modelData
                                required property int index
                                objectName: "imageSeed_" + index
                                implicitWidth: 80
                                implicitHeight: 68
                                enabled: !themeGenerator.busy
                                Accessible.name: "Use " + modelData.seed + " from image"
                                onClicked: editor.chooseCandidate(modelData)
                                contentItem: Column {
                                    spacing: 6
                                    Rectangle {
                                        width: 80; height: 42; radius: 4
                                        color: modelData.seed
                                        border.width: editor.selectedSeed === modelData.seed ? 3 : 1
                                        border.color: editor.selectedSeed === modelData.seed ? Theme.accent : Theme.border
                                    }
                                    Label { text: modelData.seed; color: Theme.text; font.pixelSize: 13 }
                                }
                            }
                        }
                    }
                }
                ColumnLayout {
                    visible: tabs.currentIndex === 1
                    Layout.fillWidth: true
                    RowLayout {
                        IconButton { objectName: "shuffleThemes"; name: "shuffle"; text: "Shuffle palettes"; enabled: !themeGenerator.busy; onClicked: editor.shuffle() }
                        IconButton { name: "back"; text: "Previous palettes"; enabled: !themeGenerator.busy && editor.randomHistory.length > 0; onClicked: editor.previousBatch() }
                        Item { Layout.fillWidth: true }
                    }
                    GridLayout {
                        Layout.fillWidth: true
                        columns: editor.availableWidth >= 480 ? 3 : 2
                        columnSpacing: 8
                        rowSpacing: 8
                        Repeater {
                            model: editor.randomCandidates
                            delegate: AbstractButton {
                                id: paletteButton
                                required property var modelData
                                required property int index
                                objectName: "randomPalette_" + index
                                Layout.fillWidth: true
                                implicitWidth: 150
                                implicitHeight: 76
                                enabled: !themeGenerator.busy
                                Accessible.name: "Use palette " + modelData.seed
                                onClicked: editor.chooseCandidate(modelData)
                                background: Rectangle {
                                    color: Theme.surfaceElevated; radius: 4
                                    border.width: editor.selectedSeed === modelData.seed ? 2 : 1
                                    border.color: editor.selectedSeed === modelData.seed ? Theme.accent : Theme.border
                                }
                                contentItem: ColumnLayout {
                                    spacing: 6
                                    Row {
                                        Layout.fillWidth: true
                                        Layout.preferredHeight: 32
                                        Repeater {
                                            model: ["background", "surface", "border", "accent", "text"]
                                            delegate: Rectangle {
                                                required property string modelData
                                                width: parent.width / 5
                                                height: 32
                                                color: paletteButton.modelData[editor.darkMode ? "dark" : "light"].colors[modelData]
                                            }
                                        }
                                    }
                                    Label { text: modelData.seed; color: Theme.text; font.pixelSize: 13; Layout.alignment: Qt.AlignHCenter }
                                }
                            }
                        }
                    }
                }
                ColumnLayout {
                    visible: tabs.currentIndex === 2
                    Layout.fillWidth: true
                    RowLayout {
                        Layout.fillWidth: true
                        AbstractButton {
                            implicitWidth: 42; implicitHeight: 42
                            enabled: !themeGenerator.busy
                            Accessible.name: "Choose source color"
                            background: Rectangle { color: /^#[0-9a-fA-F]{6}$/.test(colorField.text) ? colorField.text : Theme.surface; radius: 4; border.color: Theme.border }
                            onClicked: { sourcePicker.selectedColor = colorField.text; sourcePicker.open(); }
                        }
                        TextField {
                            id: colorField
                            objectName: "themeSourceColor"
                            Layout.fillWidth: true
                            maximumLength: 7
                            Accessible.name: "Source hex color"
                            enabled: !themeGenerator.busy
                            onTextEdited: colorDebounce.restart()
                        }
                        Button { text: "Generate"; enabled: !themeGenerator.busy; onClicked: editor.generateColor(colorField.text) }
                    }
                }
                Repeater {
                    id: manualColors
                    model: preferences.colorFields
                    delegate: RowLayout {
                        required property string modelData
                        visible: tabs.currentIndex === 3
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
                            objectName: "themeToken_" + modelData
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
            Layout.minimumHeight: 28
            BusyIndicator {
                objectName: "themeGenerationSpinner"
                Layout.preferredWidth: 24
                Layout.preferredHeight: 24
                visible: themeGenerator.busy
                running: themeGenerator.busy
            }
            Label {
                Layout.fillWidth: true
                text: themeGenerator.busy ? "Generating palette..." : editor.draftError || themeGenerator.errorMessage || editor.selectedSeed
                color: editor.draftError || themeGenerator.errorMessage ? Theme.warning : Theme.subtext
                wrapMode: Text.WordWrap
            }
            IconButton { name: "close"; text: "Cancel generation"; visible: themeGenerator.busy; onClicked: themeGenerator.cancel() }
        }
        RowLayout {
            Layout.fillWidth: true
            TabBar {
                id: modeChoice
                objectName: "themeModeChoice"
                Layout.preferredWidth: 150
                Layout.preferredHeight: 40
                enabled: !themeGenerator.busy
                TabButton { text: "Dark" }
                TabButton { text: "Light" }
                onCurrentIndexChanged: {
                    if (editor.initializing || !editor.visible) return;
                    var nextDark = currentIndex === 0;
                    if (editor.generatedCandidate.seed)
                        editor.replaceDraft(function() { editor.applyCandidate(editor.generatedCandidate, nextDark); });
                    else {
                        var next = JSON.parse(JSON.stringify(editor.document));
                        next.isDark = nextDark;
                        editor.document = next;
                        editor.preview();
                    }
                }
            }
            Item { Layout.fillWidth: true }
            Button { text: "Cancel"; onClicked: editor.close() }
            Button {
                id: saveButton
                objectName: "saveGeneratedTheme"
                text: "Save theme"
                highlighted: true
                background: Rectangle { color: !saveButton.enabled ? Theme.surfaceHover : saveButton.down ? Theme.accentPressed : saveButton.hovered ? Theme.accentHover : Theme.accent; radius: 4 }
                contentItem: Label { text: saveButton.text; color: saveButton.enabled ? Theme.accentText : Theme.faint; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                enabled: nameField.text.trim().length > 0 && !themeGenerator.busy && !editor.draftError
                onClicked: {
                    var next = JSON.parse(JSON.stringify(editor.document));
                    next.name = nameField.text.trim();
                    next.isDark = editor.darkMode;
                    if (preferences.saveTheme(next)) {
                        editor.saved();
                        editor.close();
                    }
                }
            }
        }
    }
}