import { useCallback, useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import { type SyncCommand, type SyncCommandType } from "@shared/types";

interface SubtitleTrack {
  label: string;
  language: string;
  src: string;
  format: "vtt";
  index: number;
}

export default function Player() {
  const CONTROLS_HIDE_DELAY_MS = 2000;
  const POINTER_HIDE_DELAY_MS = 1200;

  const playerContainerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const isRemoteUpdate = useRef(false);
  const hideControlsTimeoutRef = useRef<number | null>(null);
  const hidePointerTimeoutRef = useRef<number | null>(null);
  const isControlsHoveredRef = useRef(false);

  const [streamUrl, setStreamUrl] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const [subtitles, setSubtitles] = useState<SubtitleTrack[]>([]);
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState<number>(-1);
  const [isPaused, setIsPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showPointer, setShowPointer] = useState(true);

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return "00:00";

    const wholeSeconds = Math.floor(seconds);
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const secs = wholeSeconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }

    return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  const broadcast = useCallback((type: SyncCommandType) => {
    if (isRemoteUpdate.current) return;
    const video = videoRef.current;
    if (!video) return;

    window.electronAPI.sendSyncCommand({
      type,
      time: video.currentTime,
      timestamp: Date.now(),
    });
  }, []);

  const loadSubtitles = useCallback(async (url: string) => {
    const baseUrl = url.substring(0, url.lastIndexOf("/"));
    const manifestUrl = `${baseUrl}/subtitles.json`;

    console.info("[subtitles] Loading subtitle manifest", { manifestUrl });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const response = await fetch(manifestUrl);

        if (!response.ok) {
          throw new Error(
            `Manifest request failed with status ${response.status}`,
          );
        }

        const data = await response.json();
        const parsedSubs: SubtitleTrack[] = data
          .filter((subtitle: { format?: string }) => subtitle.format === "vtt")
          .map((subtitle: Omit<SubtitleTrack, "src"> & { src: string }) => ({
            ...subtitle,
            src: `${baseUrl}/${subtitle.src}`,
          }));

        setSubtitles(parsedSubs);
        setActiveSubtitleIndex(-1);
        console.info("[subtitles] Subtitle manifest loaded", {
          count: parsedSubs.length,
          labels: parsedSubs.map((track) => track.label),
        });
        return;
      } catch (error) {
        if (attempt === 7) {
          setSubtitles([]);
          setActiveSubtitleIndex(-1);
          console.error("[subtitles] Failed to load subtitle manifest", {
            manifestUrl,
            attempts: attempt + 1,
            error,
          });
          return;
        }

        console.warn("[subtitles] Subtitle manifest retry", {
          attempt: attempt + 1,
          manifestUrl,
          error,
        });

        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      }
    }
  }, []);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      void video.play();
      return;
    }

    video.pause();
  }, []);

  const handleSeek = useCallback(
    (nextTime: number) => {
      const video = videoRef.current;
      if (!video || !Number.isFinite(nextTime)) return;

      const boundedTime = Math.max(0, Math.min(nextTime, duration || nextTime));
      video.currentTime = boundedTime;
    },
    [duration],
  );

  const handleVolumeChange = useCallback((nextVolume: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(nextVolume)) return;

    const boundedVolume = Math.max(0, Math.min(nextVolume, 1));
    video.volume = boundedVolume;
    video.muted = boundedVolume === 0;
  }, []);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const playerElement = playerContainerRef.current;
    if (!playerElement) return;

    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }

    void playerElement.requestFullscreen();
  }, []);

  const toggleAlwaysOnTop = useCallback(() => {
    setIsAlwaysOnTop((currentState) => {
      const nextState = !currentState;
      window.electronAPI.setAlwaysOnTop(nextState);
      return nextState;
    });
  }, []);

  const clearHideControlsTimeout = useCallback(() => {
    if (hideControlsTimeoutRef.current === null) return;

    window.clearTimeout(hideControlsTimeoutRef.current);
    hideControlsTimeoutRef.current = null;
  }, []);

  const clearHidePointerTimeout = useCallback(() => {
    if (hidePointerTimeoutRef.current === null) return;

    window.clearTimeout(hidePointerTimeoutRef.current);
    hidePointerTimeoutRef.current = null;
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearHideControlsTimeout();

    hideControlsTimeoutRef.current = window.setTimeout(() => {
      if (isControlsHoveredRef.current) return;

      setShowControls(false);
      hideControlsTimeoutRef.current = null;
    }, CONTROLS_HIDE_DELAY_MS);
  }, [CONTROLS_HIDE_DELAY_MS, clearHideControlsTimeout]);

  const revealControls = useCallback(() => {
    setShowControls(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  const schedulePointerHide = useCallback(() => {
    clearHidePointerTimeout();

    hidePointerTimeoutRef.current = window.setTimeout(() => {
      if (isControlsHoveredRef.current) return;

      setShowPointer(false);
      hidePointerTimeoutRef.current = null;
    }, POINTER_HIDE_DELAY_MS);
  }, [POINTER_HIDE_DELAY_MS, clearHidePointerTimeout]);

  const revealPointer = useCallback(() => {
    setShowPointer(true);
    schedulePointerHide();
  }, [schedulePointerHide]);

  const setControlsHovered = useCallback(
    (isHovered: boolean) => {
      isControlsHoveredRef.current = isHovered;

      if (isHovered) {
        setShowControls(true);
        setShowPointer(true);
        clearHideControlsTimeout();
        clearHidePointerTimeout();
        return;
      }

      scheduleControlsHide();
      schedulePointerHide();
    },
    [
      clearHideControlsTimeout,
      clearHidePointerTimeout,
      scheduleControlsHide,
      schedulePointerHide,
    ],
  );

  useEffect(() => {
    let isMounted = true;

    window.electronAPI.isRoomHost().then(setIsHost);

    window.electronAPI.getRoomStreamUrl().then((url) => {
      if (!isMounted) return;

      setStreamUrl(url);
      void loadSubtitles(url);
    });

    return () => {
      isMounted = false;
    };
  }, [loadSubtitles]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;
    let isCancelled = false;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const setupPlayback = async () => {
      try {
        const { default: HlsLib } = await import("hls.js");
        if (isCancelled) return;

        if (HlsLib.isSupported()) {
          const hls = new HlsLib();
          hlsRef.current = hls;
          hls.loadSource(streamUrl);
          hls.attachMedia(video);

          hls.on(HlsLib.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;

            if (data.type === HlsLib.ErrorTypes.NETWORK_ERROR) {
              hls.startLoad();
              return;
            }

            if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
              return;
            }

            hls.destroy();
            if (hlsRef.current === hls) {
              hlsRef.current = null;
            }
          });
          return;
        }
      } catch (error) {
        console.warn("[player] Failed to load hls.js, using native playback", {
          error,
        });
      }

      if (isCancelled) return;
      video.src = streamUrl;
      video.load();
    };

    void setupPlayback();

    return () => {
      isCancelled = true;

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      video.removeAttribute("src");
      video.load();
    };
  }, [streamUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const syncMediaState = () => {
      setIsPaused(video.paused);
      setCurrentTime(
        Number.isFinite(video.currentTime) ? video.currentTime : 0,
      );
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setVolume(video.volume);
      setIsMuted(video.muted);
    };

    const onPlay = () => {
      syncMediaState();
      broadcast("play");
    };

    const onPause = () => {
      syncMediaState();
      broadcast("pause");
    };

    const onSeeked = () => {
      syncMediaState();
      broadcast("seek");
    };

    const onFullscreenChange = () => {
      setIsFullscreen(
        document.fullscreenElement === playerContainerRef.current,
      );
    };

    syncMediaState();
    onFullscreenChange();

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("timeupdate", syncMediaState);
    video.addEventListener("durationchange", syncMediaState);
    video.addEventListener("volumechange", syncMediaState);
    video.addEventListener("loadedmetadata", syncMediaState);
    document.addEventListener("fullscreenchange", onFullscreenChange);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("timeupdate", syncMediaState);
      video.removeEventListener("durationchange", syncMediaState);
      video.removeEventListener("volumechange", syncMediaState);
      video.removeEventListener("loadedmetadata", syncMediaState);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [broadcast, streamUrl]);

  useEffect(() => {
    const currentTrack =
      activeSubtitleIndex >= 0 ? subtitles[activeSubtitleIndex] : null;

    if (!currentTrack) {
      console.info("[subtitles] Subtitle selection changed", {
        selected: "off",
      });
      return;
    }

    console.info("[subtitles] Subtitle selection changed", {
      index: activeSubtitleIndex,
      label: currentTrack.label,
      src: currentTrack.src,
    });
  }, [activeSubtitleIndex, subtitles]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const syncVttTracks = () => {
      const activeTrack =
        activeSubtitleIndex >= 0 ? subtitles[activeSubtitleIndex] : null;
      const nativeTextTracks = Array.from(video.textTracks);

      nativeTextTracks.forEach((track) => {
        track.mode = "disabled";
      });

      if (!activeTrack) return;

      const selectedVttIndex = subtitles.findIndex(
        (track) => track.src === activeTrack.src,
      );

      if (selectedVttIndex >= 0 && nativeTextTracks[selectedVttIndex]) {
        nativeTextTracks[selectedVttIndex].mode = "showing";
      }
    };

    syncVttTracks();
    video.addEventListener("loadedmetadata", syncVttTracks);

    return () => {
      video.removeEventListener("loadedmetadata", syncVttTracks);
    };
  }, [activeSubtitleIndex, subtitles, streamUrl]);

  useEffect(() => {
    if (!streamUrl) return;

    const revealIfInBottomHalf = (clientY: number) => {
      if (!Number.isFinite(clientY)) return;

      if (clientY >= window.innerHeight / 2) {
        revealControls();
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      revealPointer();
      revealIfInBottomHalf(event.clientY);
    };

    const onTouchMove = (event: TouchEvent) => {
      revealPointer();

      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) return;

      revealIfInBottomHalf(touch.clientY);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("touchstart", onTouchMove, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });

    revealControls();
    revealPointer();

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("touchstart", onTouchMove);
      window.removeEventListener("touchmove", onTouchMove);
    };
  }, [revealControls, revealPointer, streamUrl]);

  useEffect(() => {
    return () => {
      clearHideControlsTimeout();
    };
  }, [clearHideControlsTimeout]);

  useEffect(() => {
    return () => {
      clearHidePointerTimeout();
    };
  }, [clearHidePointerTimeout]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video) return;

      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }

      if (event.key === " ") {
        event.preventDefault();
        revealControls();
        togglePlayback();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        revealControls();
        handleSeek((video.currentTime ?? 0) - 5);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        revealControls();
        handleSeek((video.currentTime ?? 0) + 5);
        return;
      }

      if (event.key.toLowerCase() === "m") {
        event.preventDefault();
        revealControls();
        toggleMute();
        return;
      }

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        revealControls();
        toggleFullscreen();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    handleSeek,
    revealControls,
    toggleFullscreen,
    toggleMute,
    togglePlayback,
  ]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Watchalong Session",
      artist: `Host: ${isHost ? "You" : "Remote"}`,
    });

    navigator.mediaSession.setActionHandler("play", () => {
      const video = videoRef.current;
      if (!video) return;
      void video.play();
    });

    navigator.mediaSession.setActionHandler("pause", () => {
      const video = videoRef.current;
      if (!video) return;
      video.pause();
    });

    navigator.mediaSession.setActionHandler("seekto", (details) => {
      const video = videoRef.current;
      if (!video || details.seekTime === undefined) return;
      video.currentTime = details.seekTime;
    });

    return () => {
      if (!("mediaSession" in navigator)) return;
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("seekto", null);
    };
  }, [broadcast, isHost]);

  useEffect(() => {
    const cleanup = window.electronAPI.onSyncCommand((cmd: SyncCommand) => {
      const video = videoRef.current;
      if (!video) return;
      const commandTime = cmd.time;

      if (commandTime === undefined) return;

      isRemoteUpdate.current = true;

      if (cmd.type === "heartbeat") {
        const diff = Math.abs(video.currentTime - commandTime);

        if (diff > 2) {
          video.currentTime = commandTime;
          if (cmd.state === "playing" && video.paused) void video.play();
          if (cmd.state === "paused" && !video.paused) video.pause();
        }
      } else {
        if (cmd.type === "play") void video.play();
        if (cmd.type === "pause") video.pause();
        if (
          cmd.type === "seek" ||
          Math.abs(video.currentTime - commandTime) > 2
        ) {
          video.currentTime = commandTime;
        }
      }

      window.setTimeout(() => {
        isRemoteUpdate.current = false;
      }, 500);
    });

    return cleanup;
  }, []);

  useEffect(() => {
    if (!isHost) return;

    const interval = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;

      window.electronAPI.sendSyncCommand({
        type: "heartbeat",
        time: video.currentTime,
        state: video.paused ? "paused" : "playing",
        timestamp: Date.now(),
      });
    }, 2000);

    return () => window.clearInterval(interval);
  }, [isHost]);

  return (
    <div className="h-screen w-screen bg-base-300 flex flex-col justify-center items-center overflow-hidden relative">
      {!streamUrl && (
        <div className="text-base-content animate-pulse">Loading Stream...</div>
      )}

      {streamUrl && (
        <div
          ref={playerContainerRef}
          className={`w-full h-full bg-base-300 relative ${
            showPointer ? "cursor-default" : "cursor-none"
          }`}
        >
          <video
            ref={videoRef}
            className="w-full h-full object-contain bg-black"
            playsInline
          >
            {subtitles.map((subtitle) => (
              <track
                key={subtitle.src}
                src={subtitle.src}
                kind="subtitles"
                label={subtitle.label}
                srcLang={subtitle.language}
                default={false}
              />
            ))}
          </video>

          <div
            className={`absolute inset-x-0 bottom-0 z-50 p-3 bg-linear-to-t from-black/85 to-transparent transition-opacity duration-300 ${
              showControls ? "opacity-100" : "opacity-0"
            }`}
            onMouseEnter={() => setControlsHovered(true)}
            onMouseLeave={() => setControlsHovered(false)}
          >
            <div
              className={`w-full rounded-box bg-base-100/70 backdrop-blur-md p-3 space-y-3 text-base-content ${
                showControls ? "pointer-events-auto" : "pointer-events-none"
              }`}
            >
              <input
                type="range"
                min={0}
                max={Math.max(duration || 0, 0)}
                step={0.1}
                value={Math.min(currentTime || 0, duration || 0)}
                onChange={(event) => handleSeek(Number(event.target.value))}
                className="range range-primary range-sm w-full"
                aria-label="Seek"
              />

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={togglePlayback}
                  className="btn btn-sm btn-primary"
                  aria-label={isPaused ? "Play" : "Pause"}
                >
                  <i
                    className={`fa-solid ${isPaused ? "fa-play" : "fa-pause"}`}
                  />
                </button>

                <div className="min-w-23 text-sm font-mono text-base-content/90">
                  {formatTime(currentTime || 0)} / {formatTime(duration || 0)}
                </div>

                <button
                  onClick={toggleMute}
                  className="btn btn-sm btn-ghost"
                  aria-label={isMuted || volume === 0 ? "Unmute" : "Mute"}
                >
                  <i
                    className={`fa-solid ${
                      isMuted || volume === 0
                        ? "fa-volume-xmark"
                        : "fa-volume-high"
                    }`}
                  />
                </button>

                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={isMuted ? 0 : volume || 0}
                  onChange={(event) =>
                    handleVolumeChange(Number(event.target.value))
                  }
                  className="range range-xs w-28"
                  aria-label="Volume"
                />

                {subtitles.length > 0 && (
                  <select
                    className="select select-sm select-bordered bg-base-100/80"
                    value={activeSubtitleIndex}
                    onChange={(event) =>
                      setActiveSubtitleIndex(Number(event.target.value))
                    }
                    aria-label="Subtitle selection"
                  >
                    <option value={-1}>Subtitles Off</option>
                    {subtitles.map((subtitle, index) => (
                      <option key={subtitle.src} value={index}>
                        {subtitle.label}
                      </option>
                    ))}
                  </select>
                )}

                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={toggleAlwaysOnTop}
                    className={`btn btn-sm ${
                      isAlwaysOnTop ? "btn-success" : "btn-outline"
                    }`}
                    aria-label={
                      isAlwaysOnTop
                        ? "Disable always on top"
                        : "Enable always on top"
                    }
                  >
                    <i className="fa-solid fa-thumbtack" />
                    {isAlwaysOnTop ? "On Top: ON" : "On Top: OFF"}
                  </button>

                  <button
                    onClick={toggleFullscreen}
                    className="btn btn-sm btn-ghost"
                    aria-label={
                      isFullscreen ? "Exit fullscreen" : "Enter fullscreen"
                    }
                  >
                    <i
                      className={`fa-solid ${
                        isFullscreen ? "fa-compress" : "fa-expand"
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
