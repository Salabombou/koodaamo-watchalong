import { ipcMain, BrowserWindow } from "electron";
import { TorrentService } from "@services/TorrentService";
import { IPC_CHANNELS } from "@shared/channels";
import { SyncCommand } from "@shared/types";

export class TorrentController {
  constructor(private torrentService: TorrentService) {
    this.registerHandlers();
    this.registerEvents();
  }

  private registerHandlers() {
    ipcMain.handle(
      IPC_CHANNELS.TORRENT.SEED,
      (_, filePath: string, trackerType: "lan" | "localtunnel" | "untun") => {
        return this.torrentService.seed(filePath, trackerType);
      },
    );

    ipcMain.handle(IPC_CHANNELS.TORRENT.ADD, (_, magnet: string) => {
      return this.torrentService.add(magnet);
    });

    ipcMain.handle(IPC_CHANNELS.TORRENT.IS_HOST, () => {
      return this.torrentService.isHost;
    });

    ipcMain.handle(IPC_CHANNELS.TORRENT.GET_STREAM, () => {
      return this.torrentService.getStreamUrl();
    });

    ipcMain.on(IPC_CHANNELS.TORRENT.BROADCAST, (_, cmd: SyncCommand) => {
      this.torrentService.broadcast(cmd);
    });
  }

  private registerEvents() {
    this.torrentService.on("progress", (data) => {
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.TORRENT.PROGRESS, data),
      );
    });

    this.torrentService.on("done", () => {
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.TORRENT.DONE),
      );
    });

    this.torrentService.on("sync-command", (cmd) => {
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.SYNC.COMMAND, cmd),
      );
    });

    this.torrentService.on("error", (err) => {
      BrowserWindow.getAllWindows().forEach((w) =>
        // Assuming UPDATE.ERROR might act as general error or create a new channel?
        // The original code sent 'torrent:error'.
        // I will add TORRENT.ERROR to channels if needed, or re-use UPDATE.ERROR if appropriate (probably not).
        // For now, I'll use a string literal effectively or add it to channels.
        // Let's add ERROR to TORRENT channel in a separate step or just use 'torrent:error' for compat but it's better to add to channels.
        w.webContents.send("torrent:error", err.message || err),
      );
    });
  }
}
