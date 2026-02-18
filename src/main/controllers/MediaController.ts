import { ipcMain } from "electron";
import { MediaService } from "@services/MediaService";
import { IPC_CHANNELS } from "@shared/channels";
import logger from "@utilities/logging";
import path from "path";
import crypto from "crypto";
import { StorageService } from "@services/StorageService";
import { SegmentMediaOptions } from "@shared/types";

export class MediaController {
  constructor(
    private mediaService: MediaService,
    private storageService: StorageService,
  ) {
    this.registerHandlers();
  }

  private registerHandlers() {
    ipcMain.handle(IPC_CHANNELS.MEDIA.ANALYZE, async (_, filePath: string) => {
      return this.mediaService.analyze(filePath);
    });

    ipcMain.handle(IPC_CHANNELS.MEDIA.HW_ACCEL_INFO, async () => {
      return this.mediaService.getHardwareAccelerationInfo();
    });

    ipcMain.handle(
      IPC_CHANNELS.MEDIA.NORMALIZE,
      async (event, filePath: string) => {
        const outputDir = this.storageService.getStoragePath();
        try {
          const result = await this.mediaService.normalize(
            filePath,
            outputDir,
            (p) => {
              event.sender.send(IPC_CHANNELS.MEDIA.PROGRESS, p);
            },
          );
          return result;
        } catch (e: unknown) {
          if (e instanceof Error) {
            throw new Error(e.message);
          }
          throw new Error(String(e));
        }
      },
    );

    ipcMain.handle(
      IPC_CHANNELS.MEDIA.SEGMENT,
      async (
        event,
        filePath: string,
        options: SegmentMediaOptions = {
          reEncodeVideo: true,
          reEncodeAudio: true,
          burnAssSubtitles: false,
          burnSubtitleStreamIndex: null,
          preset: "veryfast",
          scaleVideo: false,
          targetWidth: null,
          targetHeight: null,
          lockAspectRatio: true,
          useHardwareAcceleration: false,
        },
      ) => {
        const uniqueId = crypto.randomUUID();
        const outputDir = path.join(
          this.storageService.getStoragePath(),
          uniqueId,
        );

        const progressCallback = (p: number) => {
          event.sender.send(IPC_CHANNELS.MEDIA.PROGRESS, p);
        };

        try {
          logger.info(
            `Starting segmentation for ${filePath} into ${outputDir}`,
          );
          const m3u8Path = await this.mediaService.segmentMedia(
            filePath,
            outputDir,
            options,
            progressCallback,
          );
          return m3u8Path;
        } catch (e: unknown) {
          logger.error("Segmentation failed", e);
          throw e;
        }
      },
    );

    ipcMain.handle(IPC_CHANNELS.STORAGE.IMPORT, async (_, filePath: string) => {
      return this.storageService.importFile(filePath);
    });
  }
}
