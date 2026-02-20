import path from "path";
import fs from "fs";
import { app } from "electron";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import net from "net";
import logger from "@utilities/logging";

interface StartOptions {
  port: number;
  downloadsPath: string;
}

export class CloudTorrentService {
  private process: ChildProcessWithoutNullStreams | null = null;
  private port: number = 0;
  private readonly host = "127.0.0.1";
  private hasRetriedStart: boolean = false;

  private mapArch(arch: NodeJS.Architecture): string {
    if (arch === "x64") return "x64";
    if (arch === "arm64") return "arm64";
    if (arch === "ia32") return "ia32";
    if (arch === "arm") return "armv7l";
    return arch;
  }

  private getBinaryName() {
    return process.platform === "win32" ? "cloud-torrent.exe" : "cloud-torrent";
  }

  private getBinaryPath() {
    const arch = this.mapArch(process.arch);
    const platform = process.platform;
    const binaryName = this.getBinaryName();

    const packagedPath = path.join(
      process.resourcesPath,
      "cloud-torrent",
      platform,
      arch,
      binaryName,
    );

    if (app.isPackaged) {
      return packagedPath;
    }

    return path.join(
      process.cwd(),
      "resources",
      "cloud-torrent",
      platform,
      arch,
      binaryName,
    );
  }

  getBaseUrl() {
    if (!this.port) {
      return "";
    }
    return `http://${this.host}:${this.port}`;
  }

  getDownloadUrl(relativePath: string) {
    const cleanPath = relativePath.replace(/^\/+/, "");
    return `${this.getBaseUrl()}/download/${cleanPath}`;
  }

  async start(options: StartOptions): Promise<void> {
    if (this.process && !this.process.killed) {
      return;
    }

    const binaryPath = this.getBinaryPath();
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`cloud-torrent binary not found at ${binaryPath}`);
    }

    this.port = options.port;
    const incomingPort = await this.reserveIncomingPort();
    this.writeConfig(options.downloadsPath, incomingPort);

    const args = [
      `--host=${this.host}`,
      `--port=${options.port}`,
      `--config-path=${path.join(options.downloadsPath, "cloud-torrent.json")}`,
      "--open=false",
    ];

    logger.info(`Starting cloud-torrent: ${binaryPath} ${args.join(" ")}`);
    this.process = spawn(binaryPath, args, {
      cwd: options.downloadsPath,
      env: {
        ...process.env,
        HOME: options.downloadsPath,
      },
    });

    this.process.stdout.on("data", (data: Buffer) => {
      logger.info(`[cloud-torrent] ${data.toString("utf-8").trim()}`);
    });

    this.process.stderr.on("data", (data: Buffer) => {
      logger.warn(`[cloud-torrent] ${data.toString("utf-8").trim()}`);
    });

    this.process.on("exit", (code) => {
      logger.info(`[cloud-torrent] exited with code ${code}`);
      this.process = null;
    });

    try {
      await this.waitUntilReady();
      this.hasRetriedStart = false;
    } catch (error) {
      await this.stop();

      if (!this.hasRetriedStart) {
        this.hasRetriedStart = true;
        logger.warn(
          `Retrying cloud-torrent startup after failure: ${error instanceof Error ? error.message : String(error)}`,
        );
        return this.start(options);
      }

      throw error;
    }
  }

  private reserveIncomingPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();

      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Failed to reserve cloud-torrent incoming port"));
          return;
        }

        const allocatedPort = address.port;
        server.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }

          resolve(allocatedPort);
        });
      });
    });
  }

  private writeConfig(downloadsPath: string, incomingPort: number) {
    const configPath = path.join(downloadsPath, "cloud-torrent.json");
    const payload = {
      DownloadDirectory: path.join(downloadsPath, "downloads"),
      IncomingPort: incomingPort,
      AutoStart: true,
      DisableEncryption: false,
      EnableUpload: true,
      EnableSeeding: true,
    };

    fs.mkdirSync(path.join(downloadsPath, "downloads"), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), "utf-8");
  }

  private async waitUntilReady() {
    const baseUrl = this.getBaseUrl();
    const startedAt = Date.now();

    while (Date.now() - startedAt < 20000) {
      try {
        const response = await fetch(baseUrl, { method: "GET" });
        if (response.ok) {
          return;
        }
      } catch {
        // waiting for boot
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error("cloud-torrent did not become ready in time");
  }

  async addMagnet(magnet: string) {
    const response = await fetch(`${this.getBaseUrl()}/api/magnet`, {
      method: "POST",
      body: magnet,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed adding magnet to cloud-torrent: ${body}`);
    }
  }

  async stop() {
    if (!this.process) {
      return;
    }

    this.process.kill();
    this.process = null;
    this.port = 0;
    this.hasRetriedStart = false;
  }
}
