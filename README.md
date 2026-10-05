# Koodaamo Watchalong

Serverless peer-to-peer video watchalong. One **host** shares a video file; any
number of **clients** stream it directly from each other (BitTorrent-style piece
relay) and stay in sync. Everyone marks themselves Ready or Unready; the host
starts a shared three-second countdown when all required participants are ready.
Unready pauses the room and seeks everyone to the host's pause position.

- **File sharing / P2P relay** — [libtorrent](https://libtorrent.org) (DHT +
  public trackers, no server of your own).
- **Serverless control channel** — a public MQTT broker, with every message
  AES-256-GCM encrypted from the room code + password (the broker only sees
  ciphertext).
- **Players** — built-in (Qt Multimedia / FFmpeg), external **mpv**, or external
  **VLC**; each participant chooses independently.
- **GUI** — PySide6 / Qt Quick (QML).

## Requirements

- Python 3.10+
- No separate player installation is required for the built-in player.
- Optional external players: `mpv` and/or `vlc`, auto-detected or configured in Settings.
- Windows installs `pywin32` automatically for external mpv IPC.

## Install

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
```

## Run

```powershell
watchalong
# or
python -m watchalong.app
```

## Building a Windows release

Create a standalone `KoodaamoWatchalong.exe` (the target machine needs no Python)
with [PyInstaller](https://pyinstaller.org):

```powershell
scripts\build-windows.ps1            # convenience wrapper (add -Clean to rebuild)
# ...or manually:
pip install -e ".[build]"
pyinstaller packaging/watchalong.spec --noconfirm
```

The result is `dist/KoodaamoWatchalong.exe`. Qt, the QML UI, libtorrent and the
Qt Multimedia (FFmpeg) backend for the built-in player are all bundled; external
**mpv** / **VLC** stay optional and are used only if present on the target's
`PATH` or explicitly configured in Settings. Fonts, icons, sounds, and their
licenses are bundled in both source distributions and standalone builds.

### Automated releases

Pushing a version tag builds the executable on Windows CI
([`.github/workflows/release.yml`](.github/workflows/release.yml)) and attaches
it to a GitHub Release:

```powershell
git tag v0.3.0
git push origin v0.3.0
```

## Usage

1. Complete first-run setup: username, player paths, default player, appearance,
   and sound preferences. These can be changed later using Settings.
2. Enter a **room code** and optional **password** (share these with friends
   out-of-band). Anyone with both can join; the password protects the channel.
3. One person clicks **Host room**, everyone else **Join room**.
4. The host clicks **Share file** and picks a video. Preparation runs in the
   background; clients stream the video peer-to-peer.
5. Mark yourself **Ready** after loading. Playback starts together when everyone
   is ready; **Unready** pauses everyone. Space and clicking the video use the
   same readiness action. Late joiners catch up and auto-ready without pausing
   an already-playing room.
6. Choose built-in, mpv, or VLC independently. Switching players unreadies you,
   preserves the position, and shows a loading spinner with retry/fallback on failure.
7. The host can allow client seeking in Room options. Seeking pauses and starts
   a fresh countdown if everyone is still ready.

## Room and appearance

- The participant panel shows usernames, loading, readiness, host status, and
  ignored members. Smaller windows use a participant drawer.
- Host: click a participant to ignore/unignore; hold left for 1.2 seconds to
  remove and ban that profile for this room session. Hold right to open hosting
  transfer, then hold the confirmation for 1.5 seconds. Early release or moving
  away cancels; each hold shows progress. The participant menu exposes the same actions.
- Transfers preserve room/media state and the ban list. Leaving as host closes
  the room; bans are not permanent.
- Settings includes Dark and Light presets, named custom themes with live
  color preview, JSON import/export, reduced motion, and sound mute/volume.
  Theme exports contain only theme data, not profile information or player paths.
- Create themes from a local image, a newly generated harmonious random palette,
  or one source color. Choose dark/light and Balanced, Vivid, Expressive, or Muted,
  then refine individual colors in Manual. Shuffle offers six new candidates and
  a previous-batch action; image swatches remain available without rereading the file.
- Image processing is local and cancellable: PNG, JPEG, WebP, BMP, and GIF (first
  frame), up to 20 MiB and 24 million pixels. Images, paths, and generation history
  are never uploaded or included in saved/exported themes. Closing the editor
  restores the previous selection; replacing manual edits requires confirmation.
- Theme generation uses materialyoucolor's Material color algorithms and Pillow,
  rather than custom color science. Generated text and accent-button states target
  4.5:1 contrast against theme surfaces; manual themes show nonblocking warnings.
- Interface audio is from Kenney's CC0 Interface Sounds. Lucide SVG icons use
  ISC/MIT licenses and Source Sans 3 uses OFL 1.1. See
  [asset credits](src/watchalong/ui/CREDITS.txt) and the adjacent license files.
  Standalone builds also include dependency license metadata. Portions of the
  bundled Pillow libraries are based on the work of the FreeType Team
  (https://freetype.org), under the FreeType License.

## Checks

```powershell
python -m unittest discover -s tests -v
python tests/ui_smoke.py --screenshots build/ui-check
# Include installed native mpv/VLC lifecycle and fractional-seek checks:
$env:WATCHALONG_NATIVE_PLAYERS = '1'
python -m unittest discover -s tests -v
Remove-Item Env:\WATCHALONG_NATIVE_PLAYERS
```

## Notes & limitations

- The **built-in player** uses Qt Multimedia (bundled with PySide6, FFmpeg
  backend) so it works with no extra install. For formats it can't decode, use
  external mpv or VLC.
- Public MQTT brokers offer no delivery guarantees and may rate-limit; only tiny
  control messages use them, never the video. QoS 1, revisions, heartbeats, clock
  probes, and transfer retries tolerate ordinary loss and duplicate messages.
- All participants need protocol-v2 clients (0.3.0 or newer). Older clients must update.
- Shared-key encryption and sender checks are cooperative protection, not
  authenticated per-user permissions. Anyone with the room key could modify a
  client to impersonate others. Session bans can be bypassed by resetting the
  local profile identity. Use a private password and trusted participants.
- Pause positions and start timestamps are authoritative, but actual frame-level
  alignment still depends on latency, clock asymmetry, media format, and player
  seek accuracy. VLC's HTTP interface reports duration at whole-second precision.
- If the host becomes unreachable, clients pause after the heartbeat timeout.
  There is no automatic election of a new host.
- Strict/symmetric NATs can still block direct peer connections. libtorrent uses
  DHT/uTP/UPnP/NAT-PMP to maximise connectivity.
