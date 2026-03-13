import { ipcMain, BrowserWindow } from "electron";
import { RoomService } from "@services/RoomService";
import { IPC_CHANNELS } from "@shared/channels";
import { SyncCommand } from "@shared/types";

export class RoomController {
  constructor(private roomService: RoomService) {
    this.registerHandlers();
    this.registerEvents();
  }

  private registerHandlers() {
    ipcMain.handle(
      IPC_CHANNELS.ROOM.HOST,
      (
        _,
        filePath: string,
        hostAccessMode: "lan" | "localtunnel" | "untun",
      ) => {
        return this.roomService.hostRoom(filePath, hostAccessMode);
      },
    );

    ipcMain.handle(IPC_CHANNELS.ROOM.JOIN, (_, inviteUrl: string) => {
      return this.roomService.joinRoom(inviteUrl);
    });

    ipcMain.handle(IPC_CHANNELS.ROOM.IS_HOST, () => {
      return this.roomService.isHost;
    });

    ipcMain.handle(IPC_CHANNELS.ROOM.GET_STREAM, () => {
      return this.roomService.getRoomStreamUrl();
    });

    ipcMain.on(IPC_CHANNELS.ROOM.SEND_SYNC, (_, cmd: SyncCommand) => {
      void this.roomService.sendSyncCommand(cmd);
    });
  }

  private registerEvents() {
    this.roomService.on("progress", (data) => {
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.ROOM.PROGRESS, data),
      );
    });

    this.roomService.on("done", () => {
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.ROOM.READY),
      );
    });

    this.roomService.on("sync-command", (cmd) => {
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.ROOM.SYNC_COMMAND, cmd),
      );
    });

    this.roomService.on("error", (err) => {
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send(IPC_CHANNELS.ROOM.ERROR, err.message || err),
      );
    });
  }
}
