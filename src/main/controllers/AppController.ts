import { ipcMain, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { IPC_CHANNELS } from "@shared/channels";
import logger from "@utilities/logging";

export class AppController {
  constructor() {
    this.registerHandlers();
    this.setupAutoUpdater();
  }

  private registerHandlers() {
    ipcMain.handle(IPC_CHANNELS.APP.GET_VERSION, () => {
      logger.info("Renderer asked for node version");
      return process.version;
    });

    ipcMain.handle(IPC_CHANNELS.APP.RESTART, () => {
      autoUpdater.quitAndInstall();
    });
  }

  public setupAutoUpdater() {
    autoUpdater.logger = logger;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      logger.info("Checking for update...");
    });

    autoUpdater.on("update-available", (info) => {
      logger.info("Update available:", info);
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.UPDATE.AVAILABLE),
      );
    });

    autoUpdater.on("update-not-available", (info) => {
      logger.info("Update not available:", info);
    });

    autoUpdater.on("error", (err) => {
      logger.error("Error in auto-updater:", err);
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.UPDATE.ERROR, err.toString()),
      );
    });

    autoUpdater.on("download-progress", (progressObj) => {
      logger.info(
        `Download speed: ${progressObj.bytesPerSecond} - ${progressObj.percent}%`,
      );
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.UPDATE.PROGRESS, progressObj),
      );
    });

    autoUpdater.on("update-downloaded", (info) => {
      logger.info("Update downloaded", info);
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.UPDATE.DOWNLOADED),
      );
    });

    try {
      logger.info("Checking for updates...");
      autoUpdater.checkForUpdatesAndNotify();
    } catch (err) {
      logger.error("Error checking for updates:", err);
    }
  }
}
