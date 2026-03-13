export interface RoomProgress {
  progress: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  peerProgress: Record<string, number>;
}

export type HostAccessMode = "lan" | "localtunnel" | "untun";

export type SyncCommandType =
  | "play"
  | "pause"
  | "seek"
  | "chat"
  | "progress"
  | "start-room"
  | "heartbeat";

export interface SyncCommand {
  type: SyncCommandType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any;
  timestamp: number;
  time?: number;
  state?: string;
}

export interface MediaAnalysis {
  needsNormalization: boolean;
  format: string;
  codecs: {
    video: string;
    audio: string;
  };
  video: {
    width: number;
    height: number;
  };
  subtitles: {
    index: number;
    language: string;
    codec: string;
    title: string;
  }[];
  duration: number;
}

export type FfmpegPreset = "veryfast" | "fast" | "medium" | "slow" | "veryslow";

export interface SegmentMediaOptions {
  reEncodeVideo: boolean;
  reEncodeAudio: boolean;
  burnAssSubtitles: boolean;
  burnSubtitleStreamIndex: number | null;
  preset: FfmpegPreset;
  scaleVideo: boolean;
  targetWidth: number | null;
  targetHeight: number | null;
  lockAspectRatio: boolean;
  useHardwareAcceleration: boolean;
}

export interface HardwareAccelerationInfo {
  cudaCompiled: boolean;
  cudaAvailable: boolean;
  details: string;
}

export interface ElectronAPI {
  getFilePath: (file: File) => string;
  getNodeVersion: () => Promise<string>;
  resizeWindow: (width: number, height: number) => Promise<void>;
  setWindowAspectRatio: (ratio: number) => Promise<void>;
  setAlwaysOnTop: (enabled: boolean) => Promise<void>;
  importFile: (filePath: string) => Promise<string>;

  analyzeMedia: (filePath: string) => Promise<MediaAnalysis>;
  getHardwareAccelerationInfo: () => Promise<HardwareAccelerationInfo>;
  normalizeMedia: (filePath: string) => Promise<string>;
  segmentMedia: (
    filePath: string,
    options: SegmentMediaOptions,
  ) => Promise<string>;
  onMediaProgress: (callback: (percent: number) => void) => () => void;
  hostRoom: (
    filePath: string,
    hostAccessMode: HostAccessMode,
  ) => Promise<string>;
  joinRoom: (inviteUrl: string) => Promise<string>;
  isRoomHost: () => Promise<boolean>;
  getRoomStreamUrl: () => Promise<string>;
  onRoomProgress: (callback: (data: RoomProgress) => void) => () => void;
  sendSyncCommand: (cmd: SyncCommand) => void;
  onSyncCommand: (callback: (cmd: SyncCommand) => void) => () => void;
  onRoomReady: (callback: () => void) => () => void;
  onInviteOpened: (callback: (inviteUrl: string) => void) => () => void;
  openPlayerWindow: () => Promise<void>;
  restartApp: () => Promise<void>;
  onUpdateAvailable: (callback: () => void) => () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onUpdateProgress: (callback: (progress: any) => void) => () => void;
  onUpdateDownloaded: (callback: () => void) => () => void;
  onUpdateError: (callback: (err: string) => void) => () => void;
}
