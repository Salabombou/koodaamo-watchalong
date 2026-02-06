import { useEffect, useRef, useState } from "react";
import videojs from "video.js";
import "video.js/dist/video-js.css";

export default function Player() {
  const videoRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ReturnType<typeof videojs> | null>(null);
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
      .catch((err) => console.error("Failed to get stream", err));
  }, []);

  // Initialize Player
  useEffect(() => {
    if (!streamUrl) return;
    if (!videoRef.current) return;

    // Create video element explicitly to ensure clean slate on re-renders/url change
    videoRef.current.innerHTML = "";
    const videoElement = document.createElement("video-js");
    videoElement.classList.add("vjs-big-play-centered");
    videoElement.classList.add("vjs-fill"); // Make it fill the container

    videoRef.current.appendChild(videoElement);

    const player = videojs(
      videoElement,
      {
        controls: true,
        autoplay: false,
        preload: "auto",
        fluid: true,
        sources: [
          {
            src: streamUrl,
            type: "video/mp4",
          },
        ],
      },
      () => {
        console.log("VideoJS Player Ready");
      },
    );

    playerRef.current = player;

    // 1. Aspect Ratio & Resize Logic
    player.on("loadedmetadata", () => {
      const width = player.videoWidth();
      const height = player.videoHeight();

      const controlbarHeight = 30;
      const totalHeight = height + controlbarHeight * 2;

      if (width && height) {
        //window.electronAPI.resizeWindow(width, totalHeight);
        window.electronAPI.setWindowAspectRatio(width / totalHeight);
      }
    });

    // Events
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
              player.currentTime(details.seekTime);
            }
          },
        ],
        [
          "seekbackward",
          (details: MediaSessionActionDetails) => {
            const skip = details.seekOffset || 10;
            const current = player.currentTime() ?? 0;
            player.currentTime(Math.max(current - skip, 0));
          },
        ],
        [
          "seekforward",
          (details: MediaSessionActionDetails) => {
            const skip = details.seekOffset || 10;
            const current = player.currentTime() ?? 0;
            const duration = player.duration() ?? 0;
            player.currentTime(Math.min(current + skip, duration));
          },
        ],
      ] as const;

      actionHandlers.forEach(([action, handler]) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          navigator.mediaSession.setActionHandler(action, handler as any);
        } catch {
          console.warn(`Media Session action ${action} not supported`);
        }
      });
    }

    return () => {
      if (player) {
        player.dispose();
        playerRef.current = null;
      }
    };
  }, [streamUrl]);

  const broadcast = (type: string) => {
    if (isRemoteUpdate.current) return;
    if (!playerRef.current) return;

    console.log("Broadcasting:", type);

    window.electronAPI.broadcastCommand({
      type,
      time: playerRef.current.currentTime(),
      timestamp: Date.now(),
    });
  };

  // Sync Logic
  useEffect(() => {
    const cleanup = window.electronAPI.onSyncCommand((cmd) => {
      if (!playerRef.current) return;
      const player = playerRef.current;
      if (!player) return;

      console.log("Received command:", cmd);

      if (cmd.type === "heartbeat") {
        const diff = Math.abs(
          (player?.currentTime() ?? 0) - (cmd.time as number),
        );
        if (diff > 2) {
          // 2s drift threshold
          console.log("Correcting drift:", diff);
          isRemoteUpdate.current = true;
          player?.currentTime(cmd.time as number);

          if (cmd.state === "playing") {
            if (player?.paused()) player?.play()?.catch(() => {});
          } else {
            if (!player?.paused()) player?.pause();
          }

          setTimeout(() => {
            isRemoteUpdate.current = false;
          }, 500);
        }
        return;
      }

      isRemoteUpdate.current = true;

      if (cmd.type === "play") {
        player
          .play()
          ?.catch((e: unknown) => console.warn("Autoplay blocked?", e));
      } else if (cmd.type === "pause") {
        player?.pause();
      } else if (cmd.type === "seek") {
        const diff = Math.abs(
          (player?.currentTime() ?? 0) - (cmd.time as number),
        );
        if (diff > 2) {
          player?.currentTime(cmd.time as number);
        }
      }

      // Reset flag after events have fired
      setTimeout(() => {
        isRemoteUpdate.current = false;
      }, 300);
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
          time: player.currentTime(),
          state: player.paused() ? "paused" : "playing",
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
      {/* Container for video.js */}
      <div
        data-vjs-player
        ref={videoRef}
        className="w-full h-full flex items-center justify-center"
      />

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
