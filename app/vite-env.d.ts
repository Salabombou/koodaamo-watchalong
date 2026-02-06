/// <reference types="vite/client" />

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

declare const SPLASH_WINDOW_VITE_DEV_SERVER_URL: string;
declare const SPLASH_WINDOW_VITE_NAME: string;

interface TorrentProgress {
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  peerProgress: Record<string, number>;
}

interface SyncCommand {
  type: string;
  payload?: unknown;
  timestamp: number;
  [key: string]: unknown;
}

interface Window {
  electronAPI: {
    getFilePath: (file: File) => string;
    getNodeVersion: () => Promise<string>;

    // Window Management
    resizeWindow: (width: number, height: number) => Promise<void>;
    setWindowAspectRatio: (ratio: number) => Promise<void>;
    setAlwaysOnTop: (enabled: boolean) => Promise<void>;

    // Storage
    importFile: (filePath: string) => Promise<string>;

    // Media
    analyzeMedia: (filePath: string) => Promise<{
      needsNormalization: boolean;
      format: string;
      codecs: { video: string; audio: string };
      duration: number;
    }>;
    normalizeMedia: (filePath: string) => Promise<string>;
    onMediaProgress: (callback: (percent: number) => void) => () => void;

    // Torrent
    seedTorrent: (filePath: string, trackers: string[]) => Promise<string>;
    addTorrent: (magnet: string) => Promise<string>;
    checkIsHost: () => Promise<boolean>;
    getStreamUrl: () => Promise<string>;
    onTorrentProgress: (
      callback: (data: TorrentProgress) => void,
    ) => () => void;
    onTorrentDone: (callback: () => void) => () => void;

    // Sync
    broadcastCommand: (cmd: SyncCommand) => void;
    onSyncCommand: (callback: (cmd: SyncCommand) => void) => () => void;

    // Windows
    openPlayerWindow: () => Promise<void>;
  };
}
