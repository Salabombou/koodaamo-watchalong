import {
  contextBridge,
  ipcRenderer,
  type IpcRendererEvent,
  webUtils,
} from "electron";
import { IPC_CHANNELS } from "@shared/channels";
import {
  ElectronAPI,
  SyncCommand,
  RoomProgress,
  HostAccessMode,
  MediaAnalysis,
  SegmentMediaOptions,
  HardwareAccelerationInfo,
} from "@shared/types";

const electronAPI: ElectronAPI = {
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  getNodeVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP.GET_VERSION),

  // Window Management
  resizeWindow: (width: number, height: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW.RESIZE, width, height),
  setWindowAspectRatio: (ratio: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW.SET_ASPECT_RATIO, ratio),
  setAlwaysOnTop: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.WINDOW.SET_ALWAYS_ON_TOP, enabled),

  // Storage
  importFile: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.STORAGE.IMPORT, filePath),

  // Media
  analyzeMedia: (filePath: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MEDIA.ANALYZE,
      filePath,
    ) as Promise<MediaAnalysis>,
  getHardwareAccelerationInfo: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MEDIA.HW_ACCEL_INFO,
    ) as Promise<HardwareAccelerationInfo>,
  normalizeMedia: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEDIA.NORMALIZE, filePath),
  segmentMedia: (filePath: string, options: SegmentMediaOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEDIA.SEGMENT, filePath, options),
  onMediaProgress: (callback: (percent: number) => void) => {
    const subscription = (_: IpcRendererEvent, percent: number) =>
      callback(percent);
    ipcRenderer.on(IPC_CHANNELS.MEDIA.PROGRESS, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.MEDIA.PROGRESS, subscription);
  },

  // Room
  hostRoom: (
    filePath: string,
    hostAccessMode: HostAccessMode,
  ) => ipcRenderer.invoke(IPC_CHANNELS.ROOM.HOST, filePath, hostAccessMode),
  joinRoom: (inviteUrl: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROOM.JOIN, inviteUrl),
  isRoomHost: () => ipcRenderer.invoke(IPC_CHANNELS.ROOM.IS_HOST),
  getRoomStreamUrl: () => ipcRenderer.invoke(IPC_CHANNELS.ROOM.GET_STREAM),
  onRoomProgress: (callback: (data: RoomProgress) => void) => {
    const sub = (_: IpcRendererEvent, data: RoomProgress) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.ROOM.PROGRESS, sub);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ROOM.PROGRESS, sub);
  },

  // Sync
  sendSyncCommand: (cmd: SyncCommand) =>
    ipcRenderer.send(IPC_CHANNELS.ROOM.SEND_SYNC, cmd),
  onSyncCommand: (callback: (cmd: SyncCommand) => void) => {
    const sub = (_: IpcRendererEvent, cmd: SyncCommand) => callback(cmd);
    ipcRenderer.on(IPC_CHANNELS.ROOM.SYNC_COMMAND, sub);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ROOM.SYNC_COMMAND, sub);
  },

  onRoomReady: (callback: () => void) => {
    const sub = () => callback();
    ipcRenderer.on(IPC_CHANNELS.ROOM.READY, sub);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ROOM.READY, sub);
  },

  onInviteOpened: (callback: (inviteUrl: string) => void) => {
    const sub = (_: IpcRendererEvent, inviteUrl: string) => callback(inviteUrl);
    ipcRenderer.on(IPC_CHANNELS.APP.INVITE_OPENED, sub);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.APP.INVITE_OPENED, sub);
  },

  // Windows
  openPlayerWindow: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW.OPEN_PLAYER),

  // Updates
  restartApp: () => ipcRenderer.invoke(IPC_CHANNELS.APP.RESTART),
  onUpdateAvailable: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on(IPC_CHANNELS.UPDATE.AVAILABLE, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE.AVAILABLE, subscription);
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onUpdateProgress: (callback: (progress: any) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subscription = (_: IpcRendererEvent, progress: any) =>
      callback(progress);
    ipcRenderer.on(IPC_CHANNELS.UPDATE.PROGRESS, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE.PROGRESS, subscription);
  },
  onUpdateDownloaded: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on(IPC_CHANNELS.UPDATE.DOWNLOADED, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE.DOWNLOADED, subscription);
  },
  onUpdateError: (callback: (err: string) => void) => {
    const subscription = (_: IpcRendererEvent, err: string) => callback(err);
    ipcRenderer.on(IPC_CHANNELS.UPDATE.ERROR, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE.ERROR, subscription);
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
