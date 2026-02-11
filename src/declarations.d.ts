export interface TorrentProgress {
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  peerProgress: Record<string, number>;
}

export interface SyncCommand {
  type: string;
  payload?: any;
  timestamp: number;
  time?: number;
  state?: string;
}

export interface ElectronAPI {
  getFilePath: (file: File) => string;
  getNodeVersion: () => Promise<string>;
  resizeWindow: (width: number, height: number) => Promise<void>;
  setWindowAspectRatio: (ratio: number) => Promise<void>;
  setAlwaysOnTop: (enabled: boolean) => Promise<void>;
  importFile: (filePath: string) => Promise<string>;
  analyzeMedia: (filePath: string) => Promise<any>;
  normalizeMedia: (filePath: string) => Promise<string>;
  onMediaProgress: (callback: (percent: number) => void) => () => void;
  seedTorrent: (filePath: string, trackers: string[]) => Promise<string>;
  addTorrent: (magnet: string) => Promise<any>;
  checkIsHost: () => Promise<boolean>;
  getStreamUrl: () => Promise<string>;
  onTorrentProgress: (callback: (data: TorrentProgress) => void) => () => void;
  broadcastCommand: (cmd: SyncCommand | any) => void;
  onSyncCommand: (callback: (cmd: SyncCommand) => void) => () => void;
  onTorrentDone: (callback: () => void) => () => void;
  openPlayerWindow: () => Promise<void>;
  restartApp: () => Promise<void>;
  onUpdateAvailable: (callback: () => void) => () => void;
  onUpdateProgress: (callback: (progress: any) => void) => () => void;
  onUpdateDownloaded: (callback: () => void) => () => void;
  onUpdateError: (callback: (err: string) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
