import { ElectronAPI } from "./types";

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
