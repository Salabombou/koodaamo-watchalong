pragma Singleton
import QtQuick
import QtMultimedia

QtObject {
    id: sounds
    property real lastClick: 0
    readonly property real gain: preferences.values.soundsEnabled ? preferences.values.soundVolume / 100 : 0
    function play(effect) { if (gain > 0 && effect.status === SoundEffect.Ready) effect.play(); }
    function click() {
        var now = Date.now();
        if (now - lastClick >= 80) { lastClick = now; play(clickEffect); }
    }
    function ready() { play(readyEffect); }
    function unready() { play(unreadyEffect); }
    function tick() { play(tickEffect); }
    function joined() { play(joinEffect); }
    function left() { play(leaveEffect); }
    function error() { play(errorEffect); }
    property SoundEffect clickEffect: SoundEffect { source: "sounds/click_001.wav"; volume: sounds.gain }
    property SoundEffect readyEffect: SoundEffect { source: "sounds/confirmation_001.wav"; volume: sounds.gain }
    property SoundEffect unreadyEffect: SoundEffect { source: "sounds/back_001.wav"; volume: sounds.gain }
    property SoundEffect tickEffect: SoundEffect { source: "sounds/tick_001.wav"; volume: sounds.gain }
    property SoundEffect joinEffect: SoundEffect { source: "sounds/open_001.wav"; volume: sounds.gain }
    property SoundEffect leaveEffect: SoundEffect { source: "sounds/close_001.wav"; volume: sounds.gain }
    property SoundEffect errorEffect: SoundEffect { source: "sounds/error_001.wav"; volume: sounds.gain }
}