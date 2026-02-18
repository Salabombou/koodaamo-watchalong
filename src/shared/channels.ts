export const IPC_CHANNELS = {
  APP: {
    GET_VERSION: "get-node-version",
    RESTART: "update:restart",
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
  TORRENT: {
    SEED: "torrent:seed",
    ADD: "torrent:add",
    IS_HOST: "torrent:is-host",
    GET_STREAM: "torrent:get-stream",
    PROGRESS: "torrent:progress",
    BROADCAST: "torrent:broadcast",
    DONE: "torrent:done",
    ERROR: "torrent:error",
  },
  SYNC: {
    COMMAND: "sync:command",
  },
  UPDATE: {
    AVAILABLE: "update:available",
    PROGRESS: "update:progress",
    DOWNLOADED: "update:downloaded",
    ERROR: "update:error",
  },
} as const;
