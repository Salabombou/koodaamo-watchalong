import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
  webUtils,
} from "electron";

interface TorrentProgress {
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  peerProgress: Record<string, number>;
}

interface SyncCommand {
  type: "play" | "pause" | "seek" | "chat" | "progress";
  payload: unknown;
  timestamp: number;
}

const electronAPI = {
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  getNodeVersion: () => ipcRenderer.invoke("get-node-version"),

  // Window Management
  resizeWindow: (width: number, height: number) =>
    ipcRenderer.invoke("window:resize", width, height),
  setWindowAspectRatio: (ratio: number) =>
    ipcRenderer.invoke("window:set-aspect-ratio", ratio),
  setAlwaysOnTop: (enabled: boolean) =>
    ipcRenderer.invoke("window:set-always-on-top", enabled),

  // Storage
  importFile: (filePath: string) =>
    ipcRenderer.invoke("storage:import", filePath),

  // Media
  analyzeMedia: (filePath: string) =>
    ipcRenderer.invoke("media:analyze", filePath),
  normalizeMedia: (filePath: string) =>
    ipcRenderer.invoke("media:normalize", filePath),
  onMediaProgress: (callback: (percent: number) => void) => {
    const subscription = (_: IpcRendererEvent, percent: number) =>
      callback(percent);
    ipcRenderer.on("media:progress", subscription);
    return () => ipcRenderer.removeListener("media:progress", subscription);
  },

  // Torrent
  seedTorrent: (filePath: string, trackers: string[]) =>
    ipcRenderer.invoke("torrent:seed", filePath, trackers),
  addTorrent: (magnet: string) => ipcRenderer.invoke("torrent:add", magnet),
  checkIsHost: () => ipcRenderer.invoke("torrent:is-host"),
  getStreamUrl: () => ipcRenderer.invoke("torrent:get-stream"),
  onTorrentProgress: (callback: (data: TorrentProgress) => void) => {
    const sub = (_: IpcRendererEvent, data: TorrentProgress) => callback(data);
    ipcRenderer.on("torrent:progress", sub);
    return () => ipcRenderer.removeListener("torrent:progress", sub);
  },

  // Sync
  broadcastCommand: (cmd: SyncCommand) =>
    ipcRenderer.send("torrent:broadcast", cmd),
  onSyncCommand: (callback: (cmd: SyncCommand) => void) => {
    const sub = (_: IpcRendererEvent, cmd: SyncCommand) => callback(cmd);
    ipcRenderer.on("sync:command", sub);
    return () => ipcRenderer.removeListener("sync:command", sub);
  },

  onTorrentDone: (callback: () => void) => {
    const sub = () => callback();
    ipcRenderer.on("torrent:done", sub);
    return () => ipcRenderer.removeListener("torrent:done", sub);
  },

  // Windows
  openPlayerWindow: () => ipcRenderer.invoke("open-player-window"),

  // Updates
  restartApp: () => ipcRenderer.invoke("update:restart"),
  onUpdateAvailable: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on("update:available", subscription);
    return () => ipcRenderer.removeListener("update:available", subscription);
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onUpdateProgress: (callback: (progress: any) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subscription = (_: IpcRendererEvent, progress: any) =>
      callback(progress);
    ipcRenderer.on("update:progress", subscription);
    return () => ipcRenderer.removeListener("update:progress", subscription);
  },
  onUpdateDownloaded: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on("update:downloaded", subscription);
    return () => ipcRenderer.removeListener("update:downloaded", subscription);
  },
  onUpdateError: (callback: (err: string) => void) => {
    const subscription = (_: IpcRendererEvent, err: string) => callback(err);
    ipcRenderer.on("update:error", subscription);
    return () => ipcRenderer.removeListener("update:error", subscription);
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
