import fs from "fs-extra";
import path from "path";
import { v4 as uuidv4 } from "uuid";

import logger from "../utilities/logging";

export class StorageService {
  private storagePath: string;

  constructor(userDataPath: string) {
    this.storagePath = path.join(userDataPath, "watchalong-storage");
  }

  async init(): Promise<void> {
    await fs.ensureDir(this.storagePath);
  }

  async cleanup(): Promise<void> {
    try {
      const files = await fs.readdir(this.storagePath);
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;

      for (const file of files) {
        const filePath = path.join(this.storagePath, file);
        const stat = await fs.stat(filePath);

        if (now - stat.mtimeMs > oneDay) {
          await fs.remove(filePath);
          logger.info(`Cleaned up old file: ${file}`);
        }
      }
    } catch (error) {
      logger.error("Cleanup failed:", error);
    }
  }

  async importFile(sourcePath: string): Promise<string> {
    const ext = path.extname(sourcePath);
    const filename = `${uuidv4()}${ext}`;
    const destPath = path.join(this.storagePath, filename);
    await fs.copy(sourcePath, destPath);
    return destPath;
  }

  getStoragePath(): string {
    return this.storagePath;
  }
}
