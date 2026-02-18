import { useEffect, useRef, useState } from "react";
import Plyr from "plyr";
import Hls from "hls.js";
import "plyr/dist/plyr.css";

export default function Player() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Plyr | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [streamUrl, setStreamUrl] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
  const isRemoteUpdate = useRef(false);

  useEffect(() => {
    // Check host status
    window.electronAPI.checkIsHost().then(setIsHost);

    // Get stream
    window.electronAPI
      .getStreamUrl()
      .then((url) => {
        console.log("Stream URL:", url);
        setStreamUrl(url);
      })
      .catch((err: unknown) => console.error("Failed to get stream", err));
  }, []);

  // Initialize Player
  useEffect(() => {
    if (!streamUrl) return;
    const video = videoRef.current;
    if (!video) return;

    // Destroy existing instance if any before creating new one
    if (playerRef.current) {
      playerRef.current.destroy();
      playerRef.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const defaultOptions = {
      controls: [
        "play-large",
        "play",
        "progress",
        "current-time",
        "mute",
        "volume",
        "captions",
        "settings",
        "pip",
        "airplay",
        "fullscreen",
      ],
      autoplay: false,
    };

    if (streamUrl.endsWith(".m3u8")) {
      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hlsRef.current = hls;
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = streamUrl;
      }
    } else {
      video.src = streamUrl;
    }

    const player = new Plyr(video, defaultOptions);
    playerRef.current = player;

    // 1. Aspect Ratio & Resize Logic
    player.on("loadedmetadata", () => {
      // Access the underlying HTMLVideoElement
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const videoElement = (player as any).media;
      const width = videoElement.videoWidth;
      const height = videoElement.videoHeight;

      const controlbarHeight = 30;
      const totalHeight = height + controlbarHeight * 2;

      if (width && height) {
        window.electronAPI.setWindowAspectRatio(width / totalHeight);
      }
    });

    // Events
    const broadcast = (type: string) => {
      if (isRemoteUpdate.current) return;
      if (!playerRef.current) return;

      console.log("Broadcasting:", type);

      window.electronAPI.broadcastCommand({
        type,
        time: playerRef.current.currentTime,
        timestamp: Date.now(),
      });
    };

    player.on("play", () => broadcast("play"));
    player.on("pause", () => broadcast("pause"));
    player.on("seeked", () => broadcast("seek"));

    // 3. Media Session API Integration
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Koodaamo Watch Party",
      });

      const actionHandlers = [
        ["play", () => player.play()],
        ["pause", () => player.pause()],
        [
          "seekto",
          (details: MediaSessionActionDetails) => {
            if (details.seekTime !== undefined && details.seekTime !== null) {
              player.currentTime = details.seekTime;
            }
          },
        ],
        [
          "seekbackward",
          (details: MediaSessionActionDetails) => {
            const skip = details.seekOffset || 10;
            const current = player.currentTime;
            player.currentTime = Math.max(current - skip, 0);
          },
        ],
        [
          "seekforward",
          (details: MediaSessionActionDetails) => {
            const skip = details.seekOffset || 10;
            const current = player.currentTime;
            const duration = player.duration;
            player.currentTime = Math.min(current + skip, duration);
          },
        ],
      ] as const;

      actionHandlers.forEach(([action, handler]) => {
        try {
          navigator.mediaSession.setActionHandler(action, handler);
        } catch {
          console.warn(`Media Session action ${action} not supported`);
        }
      });
    }

    return () => {
      if (player) {
        player.destroy();
        playerRef.current = null;
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [streamUrl]);

  // Sync Logic
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = window.electronAPI.onSyncCommand((cmd: any) => {
      if (!playerRef.current) return;
      const player = playerRef.current;

      console.log("Received command:", cmd);

      // Helper to avoid broadcast loop
      const runRemoteAction = (action: () => void) => {
        isRemoteUpdate.current = true;
        action();
        // Reset flag after events have fired
        setTimeout(() => {
          isRemoteUpdate.current = false;
        }, 500);
      };

      if (cmd.type === "heartbeat") {
        const serverTime = cmd.time as number;
        const localTime = player.currentTime;
        const diff = Math.abs(localTime - serverTime);

        if (diff > 2) {
          // 2s drift threshold
          console.log("Correcting drift:", diff);

          runRemoteAction(() => {
            player.currentTime = serverTime;

            if (cmd.state === "playing") {
              if (player.paused) player.play();
            } else {
              if (!player.paused) player.pause();
            }
          });
        }
        return;
      }

      runRemoteAction(() => {
        if (cmd.type === "play") {
          const promise = player.play();
          if (promise) {
            promise.catch((e: unknown) => console.warn("Autoplay blocked?", e));
          }
        } else if (cmd.type === "pause") {
          player.pause();
        } else if (cmd.type === "seek") {
          const diff = Math.abs(player.currentTime - (cmd.time as number));
          if (diff > 2) {
            player.currentTime = cmd.time as number;
          }
        }
      });
    });

    return cleanup;
  }, []);

  // Host Heartbeat
  useEffect(() => {
    if (!isHost) return;

    const interval = setInterval(() => {
      if (playerRef.current) {
        const player = playerRef.current;
        window.electronAPI.broadcastCommand({
          type: "heartbeat",
          time: player.currentTime,
          state: player.paused ? "paused" : "playing",
          timestamp: Date.now(),
        });
      }
    }, 2000); // 2s heartbeat

    return () => clearInterval(interval);
  }, [isHost]);

  // 2. Toggle Always On Top
  const toggleAlwaysOnTop = () => {
    const newState = !isAlwaysOnTop;
    setIsAlwaysOnTop(newState);
    window.electronAPI.setAlwaysOnTop(newState);
  };

  return (
    <div className="h-screen w-screen bg-black flex flex-col justify-center items-center overflow-hidden relative group">
      {!streamUrl && (
        <div className="text-white animate-pulse">Loading Stream...</div>
      )}

      {/* Container for Plyr - using a video tag directly */}
      <div className="w-full h-full flex items-center justify-center">
        <video
          ref={videoRef}
          className="plyr-react plyr"
          playsInline
          controls
        />
      </div>

      {/* Always On Top Toggle */}
      <div className="absolute top-4 right-4 z-50 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <button
          onClick={toggleAlwaysOnTop}
          className={`px-3 py-1.5 rounded-md text-sm font-medium shadow-md transition-colors ${
            isAlwaysOnTop
              ? "bg-green-600 text-white hover:bg-green-700"
              : "bg-gray-800/80 text-gray-200 hover:bg-gray-700"
          }`}
        >
          {isAlwaysOnTop ? "Always On Top: ON" : "Always On Top: OFF"}
        </button>
      </div>
    </div>
  );
}
