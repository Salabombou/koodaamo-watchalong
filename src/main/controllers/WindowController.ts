import { ipcMain, BrowserWindow } from "electron";
import { IPC_CHANNELS } from "@shared/channels";

export class WindowController {
  constructor(private createPlayerWindow: () => void) {
    this.registerHandlers();
  }

  private registerHandlers() {
    ipcMain.handle(
      IPC_CHANNELS.WINDOW.RESIZE,
      (event, width: number, height: number) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (window) {
          window.setContentSize(Math.round(width), Math.round(height), true);
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.WINDOW.SET_ASPECT_RATIO,
      (event, ratio: number) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        window?.setAspectRatio(ratio);
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.WINDOW.SET_ALWAYS_ON_TOP,
      (event, enabled: boolean) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        window?.setAlwaysOnTop(enabled, "screen-saver");
      },
    );

    ipcMain.handle(IPC_CHANNELS.WINDOW.OPEN_PLAYER, () => {
      this.createPlayerWindow();
    });
  }
}
