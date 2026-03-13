export const IPC_CHANNELS = {
  APP: {
    GET_VERSION: "get-node-version",
    RESTART: "update:restart",
    INVITE_OPENED: "app:invite-opened",
  },
  WINDOW: {
    RESIZE: "window:resize",
    SET_ASPECT_RATIO: "window:set-aspect-ratio",
    SET_ALWAYS_ON_TOP: "window:set-always-on-top",
    OPEN_PLAYER: "open-player-window",
  },
  STORAGE: {
    IMPORT: "storage:import",
  },
  MEDIA: {
    ANALYZE: "media:analyze",
    HW_ACCEL_INFO: "media:hw-accel-info",
    NORMALIZE: "media:normalize",
    SEGMENT: "media:segment",
    PROGRESS: "media:progress",
  },
  ROOM: {
    HOST: "room:host",
    JOIN: "room:join",
    IS_HOST: "room:is-host",
    GET_STREAM: "room:get-stream",
    PROGRESS: "room:progress",
    SEND_SYNC: "room:send-sync",
    READY: "room:ready",
    SYNC_COMMAND: "room:sync-command",
    ERROR: "room:error",
  },
  UPDATE: {
    AVAILABLE: "update:available",
    PROGRESS: "update:progress",
    DOWNLOADED: "update:downloaded",
    ERROR: "update:error",
  },
} as const;
