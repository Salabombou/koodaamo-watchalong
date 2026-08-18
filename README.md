# Koodaamo Watchalong

Serverless peer-to-peer video watchalong. One **host** shares a video file; any
number of **clients** stream it directly from each other (BitTorrent-style piece
relay) and stay in sync. Playback control (play / pause / seek) is authoritative
to the host, who decides whether clients may pause or seek.

- **File sharing / P2P relay** — [libtorrent](https://libtorrent.org) (DHT +
  public trackers, no server of your own).
- **Serverless control channel** — a public MQTT broker, with every message
  AES-256-GCM encrypted from the room code + password (the broker only sees
  ciphertext).
- **Players** — built-in (embedded libmpv), external **mpv**, or external
  **VLC**; each participant chooses independently.
- **GUI** — PySide6 / Qt Quick (QML).

## Requirements

- Python 3.10+
- **libmpv** native library for the built-in player
  (`mpv-2.dll` on Windows must be on `PATH`; `libmpv` package on Linux;
  `brew install mpv` on macOS).
- Optional external players: `mpv` and/or `vlc` on `PATH`.
- On Windows, `pywin32` is needed to control an *external* mpv (built-in mpv and
  VLC do not need it).

## Install

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
# Windows, if you want to control external mpv:
pip install -e ".[win]"
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
`PATH`.

### Automated releases

Pushing a version tag builds the executable on Windows CI
([`.github/workflows/release.yml`](.github/workflows/release.yml)) and attaches
it to a GitHub Release:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## Usage

1. Enter a **room code** and optional **password** (share these with friends
   out-of-band). Anyone with both can join; the password protects the channel.
2. One person clicks **Host room**, everyone else **Join room**.
3. The host clicks **Share file…** and picks a video. Clients start streaming it
   peer-to-peer and follow the host's playback.
4. The host toggles **Clients can pause / seek** to grant control.
5. Each participant can switch between built-in / mpv / VLC at any time.

## Notes & limitations

- The **built-in player** uses Qt Multimedia (bundled with PySide6, FFmpeg
  backend) so it works with no extra install. For formats it can't decode, use
  external mpv or VLC.
- Public MQTT brokers offer no delivery guarantees and may rate-limit; only tiny
  control messages use them, never the video.
- Strict/symmetric NATs can still block direct peer connections. libtorrent uses
  DHT/uTP/UPnP/NAT-PMP to maximise connectivity.
