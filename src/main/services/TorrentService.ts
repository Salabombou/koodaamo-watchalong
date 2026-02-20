import WebTorrent from "webtorrent";
import { TrackerService } from "./TrackerService";
import { CloudTorrentService } from "./CloudTorrentService";
import { SyncCommand } from "@shared/types";
import { EventEmitter } from "events";
import rangeParser from "range-parser";
import http from "http";
import path from "path";
import fs from "fs";
import type { AddressInfo } from "net";
import net from "net";
import { app } from "electron";
import { WebSocket } from "ws";
import logger from "@utilities/logging";

export class TorrentService extends EventEmitter {
  client: WebTorrent.Instance | undefined;
  clientReady: Promise<WebTorrent.Instance>;

  private trackerService = new TrackerService();

  activeTorrent: WebTorrent.Torrent | null = null;
  isHost: boolean = false;
  private peerProgress: Map<string, number> = new Map();
  private lastEmit: number = 0;
  private lastConsoleLog: number = 0;

  private server: http.Server | null = null;
  private streamPort: number = 0;

  private syncSocket: WebSocket | null = null;
  private syncAccessKey: string | null = null;
  private cloudTorrentService = new CloudTorrentService();
  private cloudStreamPath: string = "";
  private cloudPort: number = 0;
  private cloudDownloadsPath: string;

  private static readonly PUBLIC_FALLBACK_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.stealth.si:80/announce",
    "https://tracker.opentrackr.org:443/announce",
  ];

  private static readonly TELEMETRY_PREFIX = "[telemetry]";

  constructor() {
    super();
    this.cloudDownloadsPath = path.join(
      app.getPath("userData"),
      "cloud-torrent",
      `instance-${process.pid}`,
    );
    fs.mkdirSync(this.cloudDownloadsPath, { recursive: true });
    this.clientReady = this.initClient();
    this.clientReady.catch((err) => {
      logger.error("Failed to initialize WebTorrent client:", err);
    });
    this.startServer();
  }

  private startServer() {
    this.server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Range");

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      this.handleHttpCallback(req, res);
    });

    this.server.listen(0, "127.0.0.1", () => {
      const addr = this.server!.address() as AddressInfo;
      this.streamPort = addr.port;
      logger.info(
        `Stream server listening on http://127.0.0.1:${this.streamPort}`,
      );
    });
  }

  private async reserveCloudPort() {
    if (this.cloudPort > 0) {
      return this.cloudPort;
    }

    this.cloudPort = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Failed to allocate cloud-torrent port"));
          return;
        }

        const allocatedPort = address.port;
        server.close(() => resolve(allocatedPort));
      });
    });

    return this.cloudPort;
  }

  private async ensureCloudStarted() {
    const port = await this.reserveCloudPort();
    await this.cloudTorrentService.start({
      port,
      downloadsPath: this.cloudDownloadsPath,
    });
  }

  private resolvePreferredStreamPath(torrent: WebTorrent.Torrent) {
    const normalizeCloudPath = (filePath: string) => {
      const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
      if (normalized.includes("/")) {
        return normalized;
      }

      const infoHash = torrent.infoHash?.trim();
      if (!infoHash) {
        return normalized;
      }

      return `${infoHash}/${normalized}`;
    };

    const preferred = torrent.files.find((file) => file.path.endsWith("master.m3u8"));
    if (preferred) {
      return normalizeCloudPath(preferred.path);
    }

    const fallbackPlaylist = torrent.files.find((file) => file.path.endsWith(".m3u8"));
    if (fallbackPlaylist) {
      return normalizeCloudPath(fallbackPlaylist.path);
    }

    const fallbackVideo = torrent.files.find((file) =>
      /\.(mp4|webm|mkv|avi)$/i.test(file.path),
    );
    return fallbackVideo ? normalizeCloudPath(fallbackVideo.path) : "";
  }

  private async setupCloudStreamForTorrent(
    magnetUri: string,
    torrent: WebTorrent.Torrent,
  ) {
    try {
      await this.ensureCloudStarted();
      await this.cloudTorrentService.addMagnet(magnetUri);
      this.cloudStreamPath = this.resolvePreferredStreamPath(torrent);
    } catch (error) {
      logger.warn(
        `Failed to initialize cloud-torrent streaming: ${this.toErrorMessage(error)}`,
      );
    }
  }

  private handleHttpCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const requestUrl = req.url || "/";
    const normalizedPath = decodeURIComponent(requestUrl.split("?")[0]);

    if (normalizedPath.startsWith("/cloud/")) {
      void this.proxyCloudRequest(req, res, normalizedPath);
      return;
    }

    if (!this.activeTorrent || !this.activeTorrent.ready) {
      res.statusCode = 503;
      res.end("Torrent not ready");
      return;
    }

    const url = req.url || "/";
    const cleanUrl = decodeURIComponent(url.split("?")[0]);
    let targetPath = cleanUrl;

    if (targetPath.startsWith("/stream/")) {
      targetPath = targetPath.slice("/stream/".length);
    } else if (targetPath === "/stream") {
      targetPath = "";
    }

    let file: WebTorrent.TorrentFile | undefined;

    if (targetPath === "" || targetPath === "/") {
      file = this.activeTorrent.files.find((f) => f.name.endsWith(".m3u8"));
      if (!file) {
        file = this.activeTorrent.files.find((f) =>
          /\.(mp4|webm|mkv|avi)$/i.test(f.name),
        );
      }
    } else {
      file = this.activeTorrent.files.find((f) => {
        return f.name === targetPath || f.path.endsWith(targetPath);
      });
    }

    if (!file) {
      res.statusCode = 404;
      res.end("File not found");
      return;
    }

    file.select();

    const absPath = path.join(this.activeTorrent.path, file.path);

    if (!fs.existsSync(absPath)) {
      res.statusCode = 404;
      res.end("File not yet downloaded or missing");
      return;
    }

    const stat = fs.statSync(absPath);
    const fileSize = stat.size;

    let contentType = "application/octet-stream";
    if (file.name.endsWith(".m3u8"))
      contentType = "application/vnd.apple.mpegurl";
    else if (file.name.endsWith(".ts")) contentType = "video/mp2t";
    else if (file.name.endsWith(".mp4")) contentType = "video/mp4";
    else if (file.name.endsWith(".webm")) contentType = "video/webm";
    else if (file.name.endsWith(".vtt")) contentType = "text/vtt";

    const rangeHeader = req.headers.range;

    if (!rangeHeader) {
      res.setHeader("Content-Length", fileSize);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Accept-Ranges", "bytes");

      const stream = fs.createReadStream(absPath);
      stream.pipe(res);
      stream.on("error", (err) => {
        logger.error("Stream error", err);
        if (!res.headersSent) res.end();
      });
      return;
    }

    const parts = rangeParser(fileSize, rangeHeader);

    if (parts === -1 || parts === -2 || !Array.isArray(parts)) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      res.end();
      return;
    }

    const { start, end } = parts[0];
    const chunksize = end - start + 1;

    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", chunksize);
    res.setHeader("Content-Type", contentType);

    const stream = fs.createReadStream(absPath, { start, end });
    stream.pipe(res);

    stream.on("error", (err: unknown) => {
      logger.error(`Stream error:`, err);
      if (!res.headersSent) {
        res.end();
      }
    });
  }

  private async proxyCloudRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    normalizedPath: string,
  ) {
    const targetPath = normalizedPath.slice("/cloud/".length);
    if (!targetPath) {
      res.statusCode = 404;
      res.end("Cloud path missing");
      return;
    }

    const encodedPath = targetPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const query = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const targetUrl = `${this.cloudTorrentService.getDownloadUrl(encodedPath)}${query}`;

    try {
      const headers: Record<string, string> = {};
      if (req.headers.range) {
        headers.Range = req.headers.range;
      }
      headers["Accept-Encoding"] = "identity";

      const upstreamResponse = await fetch(targetUrl, {
        method: req.method || "GET",
        headers,
      });

      res.statusCode = upstreamResponse.status;
      for (const [header, value] of upstreamResponse.headers.entries()) {
        const lowerHeader = header.toLowerCase();
        if (
          lowerHeader === "transfer-encoding" ||
          lowerHeader === "content-encoding" ||
          lowerHeader === "content-length" ||
          lowerHeader === "connection"
        ) {
          continue;
        }
        res.setHeader(header, value);
      }

      const bodyBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
      res.setHeader("Content-Length", bodyBuffer.length);
      res.end(bodyBuffer);
    } catch (error) {
      logger.error(
        `Cloud proxy error for ${targetUrl}: ${this.toErrorMessage(error)}`,
      );
      if (!res.headersSent) {
        res.statusCode = 502;
      }
      res.end("Unable to proxy cloud stream");
    }
  }

  private async initClient() {
    logger.info("Initializing WebTorrent client...");
    logger.info(
      `Using webtorrent (${WebTorrent.WEBRTC_SUPPORT ? "WebRTC" : "TCP/UDP"})`,
    );
    this.client = new WebTorrent({
      utp: true,
      dht: true,
      tracker: true,
    });
    this.logTelemetry("client_runtime", {
      webrtcSupport: WebTorrent.WEBRTC_SUPPORT,
      utp: true,
      dht: true,
      tracker: true,
    });
    this.client!.setMaxListeners(20);

    this.client!.on("error", (err: unknown) => {
      logger.error(`WebTorrent Client Error:`, err);
      this.emit("error", err);
    });

    this.client.on("torrent", (torrent: WebTorrent.Torrent) => {
      logger.info(`Torrent added: ${torrent.infoHash}`);
    });

    return this.client!;
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private createTraceId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private logTelemetry(event: string, fields: Record<string, unknown>) {
    logger.info(
      `${TorrentService.TELEMETRY_PREFIX} ${JSON.stringify({ event, ...fields })}`,
    );
  }

  private extractTrackersFromMagnet(magnetURI: string): string[] {
    const queryIndex = magnetURI.indexOf("?");
    if (queryIndex === -1) return [];

    const query = magnetURI.slice(queryIndex + 1);
    const params = new URLSearchParams(query);
    const trackers = params.getAll("tr").map((value) => value.trim());

    return Array.from(new Set(trackers.filter(Boolean)));
  }

  private getTrackerAttemptOrder(
    preferred: "lan" | "localtunnel" | "untun",
  ): Array<"lan" | "localtunnel" | "untun"> {
    if (preferred === "lan") return ["lan"];
    if (preferred === "untun") return ["untun", "localtunnel"];
    return ["localtunnel", "untun"];
  }

  private async startTrackerWithFallback(
    preferred: "lan" | "localtunnel" | "untun",
    traceId: string,
  ): Promise<{ announceUrl: string; mode: "lan" | "localtunnel" | "untun" }> {
    const attemptOrder = this.getTrackerAttemptOrder(preferred);
    const attemptErrors: string[] = [];

    this.logTelemetry("tracker_attempt_order", {
      traceId,
      preferred,
      order: attemptOrder,
    });

    for (const mode of attemptOrder) {
      const startedAt = Date.now();
      this.trackerService.stop();

      try {
        const announceUrl = await this.trackerService.start(mode);
        this.logTelemetry("tracker_start_success", {
          traceId,
          preferred,
          mode,
          durationMs: Date.now() - startedAt,
          announceUrl,
        });
        return { announceUrl, mode };
      } catch (error) {
        const message = this.toErrorMessage(error);
        const durationMs = Date.now() - startedAt;
        attemptErrors.push(`${mode}: ${message}`);
        this.logTelemetry("tracker_start_failure", {
          traceId,
          preferred,
          mode,
          durationMs,
          error: message,
        });
        logger.warn(`Tracker start failed for ${mode}: ${message}`);
        this.trackerService.stop();
      }
    }

    throw new Error(
      `Unable to start tracker after ${attemptOrder.length} attempt(s): ${attemptErrors.join(" | ")}`,
    );
  }

  private buildAnnounceList(
    trackerType: "lan" | "localtunnel" | "untun",
    primaryTracker: string,
  ): string[] {
    const trackers = [primaryTracker];

    if (trackerType !== "lan") {
      trackers.push(...TorrentService.PUBLIC_FALLBACK_TRACKERS);
    }

    return Array.from(
      new Set(trackers.map((url) => url.trim()).filter(Boolean)),
    );
  }

  private appendMagnetParam(magnetUri: string, key: string, value: string) {
    const separator = magnetUri.includes("?") ? "&" : "?";
    return `${magnetUri}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }

  private extractMagnetParam(magnetUri: string, key: string) {
    const queryIndex = magnetUri.indexOf("?");
    if (queryIndex === -1) {
      return "";
    }

    const params = new URLSearchParams(magnetUri.slice(queryIndex + 1));
    return params.get(key) || "";
  }

  private closeSyncSocket() {
    if (!this.syncSocket) {
      return;
    }

    try {
      this.syncSocket.close();
    } catch {
      // ignore close errors
    }

    this.syncSocket = null;
  }

  private attachSyncSocketHandlers() {
    if (!this.syncSocket) {
      return;
    }

    this.syncSocket.on("message", (payload) => {
      try {
        const command = JSON.parse(payload.toString("utf-8")) as SyncCommand;
        if (
          this.isHost &&
          command.type === "progress" &&
          command.payload &&
          typeof command.payload === "object"
        ) {
          const payloadObject = command.payload as {
            peerId?: string;
            percent?: number;
          };

          if (
            payloadObject.peerId &&
            typeof payloadObject.percent === "number" &&
            Number.isFinite(payloadObject.percent)
          ) {
            this.peerProgress.set(payloadObject.peerId, payloadObject.percent);
            this.emitProgress();
          }
        }

        this.emit("sync-command", command);
      } catch (error) {
        logger.warn(`Invalid sync command payload: ${this.toErrorMessage(error)}`);
      }
    });

    this.syncSocket.on("close", () => {
      logger.info("Sync socket disconnected");
      this.syncSocket = null;
    });

    this.syncSocket.on("error", (error) => {
      logger.error("Sync socket error", error);
      this.emit("error", error);
    });
  }

  private connectSyncSocket(syncUrl: string) {
    this.closeSyncSocket();

    logger.info(`Connecting sync socket: ${syncUrl}`);
    this.syncSocket = new WebSocket(syncUrl);

    this.syncSocket.on("open", () => {
      logger.info("Sync socket connected");
    });

    this.attachSyncSocketHandlers();
  }

  private buildRemoteSyncUrlFromMagnet(
    magnetURI: string,
    infoHash: string,
    accessKey: string,
  ) {
    const trackers = this.extractTrackersFromMagnet(magnetURI);
    const announceUrl = trackers.find((tracker) =>
      /^https?:\/\//i.test(tracker),
    );

    if (!announceUrl) {
      return "";
    }

    return this.trackerService.toRemoteSyncUrl(
      announceUrl,
      infoHash,
      accessKey,
      "peer",
    );
  }

  async seed(
    filePath: string,
    trackerType: "lan" | "localtunnel" | "untun" = "localtunnel",
  ): Promise<string> {
    const client = await this.clientReady;
    const traceId = this.createTraceId();

    this.logTelemetry("seed_start", {
      traceId,
      trackerType,
      filePath,
    });

    logger.info(
      `Starting seed for: ${filePath} with tracker type: ${trackerType}`,
    );

    let seedPath = filePath;
    if (filePath.endsWith(".m3u8")) {
      seedPath = path.dirname(filePath);
      logger.info(`Detected HLS playlist. Seeding directory: ${seedPath}`);
    }

    const startTime = Date.now();

    let localTrackerUrl = "";
    let resolvedTrackerType: "lan" | "localtunnel" | "untun" = trackerType;
    try {
      logger.info("Starting tracker service...");
      const trackerStart = await this.startTrackerWithFallback(
        trackerType,
        traceId,
      );
      localTrackerUrl = trackerStart.announceUrl;
      resolvedTrackerType = trackerStart.mode;
      logger.info(
        `Tracker service started at ${localTrackerUrl} (resolved mode: ${resolvedTrackerType})`,
      );
    } catch (err) {
      logger.error("Failed to start tracker service", err);
      this.logTelemetry("seed_tracker_unavailable", {
        traceId,
        trackerType,
        error: this.toErrorMessage(err),
      });
      throw new Error(
        `Unable to start tracker for ${trackerType}: ${this.toErrorMessage(err)}`,
      );
    }

    this.syncAccessKey = this.trackerService.rotateSyncAccessKey();

    const announce = this.buildAnnounceList(
      resolvedTrackerType,
      localTrackerUrl,
    );
    if (announce.length === 0) {
      throw new Error("No valid trackers available for this session");
    }

    this.logTelemetry("seed_trackers_selected", {
      traceId,
      trackerType,
      resolvedTrackerType,
      announce,
    });

    return new Promise((resolve, reject) => {
      let settled = false;

      const torrentHandle = client.seed(
        seedPath,
        { announce },
        (torrent: WebTorrent.Torrent) => {
          this.handleTorrent(torrent);
          this.isHost = true;

          const baseMagnet = torrent.magnetURI;
          const magnetWithSync = this.syncAccessKey
            ? this.appendMagnetParam(
                baseMagnet,
                "x-watchalong-key",
                this.syncAccessKey,
              )
            : baseMagnet;

          if (this.syncAccessKey) {
            const hostSyncUrl = this.trackerService.getLocalSyncUrl(
              torrent.infoHash,
              this.syncAccessKey,
              "host",
            );
            this.connectSyncSocket(hostSyncUrl);
          }

          void this.setupCloudStreamForTorrent(baseMagnet, torrent);

          settled = true;
          resolve(magnetWithSync);
        },
      );

      torrentHandle.on("warning", (err: unknown) => {
        logger.warn("Warning during seed:", err);
      });

      torrentHandle.on("error", (err: unknown) => {
        logger.error("Error during seed:", err);
        if (!settled) {
          settled = true;
          reject(
            err instanceof Error ? err : new Error(this.toErrorMessage(err)),
          );
        }
      });

      torrentHandle.on("metadata", () => {
        this.logTelemetry("seed_metadata", {
          traceId,
          trackerType,
          resolvedTrackerType,
          durationMs: Date.now() - startTime,
        });
      });
    });
  }

  async add(magnetURI: string): Promise<string> {
    const client = await this.clientReady;
    const traceId = this.createTraceId();
    const startedAt = Date.now();

    this.logTelemetry("add_start", {
      traceId,
      magnetLength: magnetURI.length,
    });

    this.closeSyncSocket();

    const torrent = client.add(magnetURI);

    this.handleTorrent(torrent);
    this.isHost = false;
    this.syncAccessKey = this.extractMagnetParam(magnetURI, "x-watchalong-key");

    return new Promise((resolve) => {
      torrent.on("infoHash", () => {
        this.logTelemetry("add_infohash", {
          traceId,
          infoHash: torrent.infoHash,
          durationMs: Date.now() - startedAt,
        });

        if (this.syncAccessKey) {
          const peerSyncUrl = this.buildRemoteSyncUrlFromMagnet(
            magnetURI,
            torrent.infoHash,
            this.syncAccessKey,
          );

          if (peerSyncUrl) {
            this.connectSyncSocket(peerSyncUrl);
          }
        }

        void this.setupCloudStreamForTorrent(magnetURI, torrent);

        resolve(torrent.infoHash);
      });

      torrent.on("warning", (err: unknown) => {
        this.logTelemetry("add_warning", {
          traceId,
          warning: this.toErrorMessage(err),
        });
      });

      torrent.on("error", (err: unknown) => {
        this.logTelemetry("add_error", {
          traceId,
          error: this.toErrorMessage(err),
        });
      });

      if (torrent.infoHash) {
        resolve(torrent.infoHash);
      }
    });
  }

  private handleTorrent(torrent: WebTorrent.Torrent) {
    this.activeTorrent = torrent;
    this.peerProgress.clear();
    this.lastEmit = 0;

    torrent.on("done", () => {
      logger.info("Torrent download/seed complete");
      this.emitProgress(true);
      this.emit("done");
    });

    const onProgress = () => this.emitProgress();
    torrent.on("download", onProgress);
    torrent.on("upload", onProgress);

    this.emitProgress(true);
  }

  getStreamUrl(): string {
    if (this.cloudStreamPath) {
      const encodedPath = this.cloudStreamPath
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      return `http://127.0.0.1:${this.streamPort}/cloud/${encodedPath}`;
    }

    if (this.streamPort === 0) return "";
    return `http://127.0.0.1:${this.streamPort}/stream/master.m3u8`;
  }

  private emitProgress(force = false) {
    if (!this.activeTorrent) return;

    const now = Date.now();

    if (now - this.lastConsoleLog > 3000) {
      this.lastConsoleLog = now;
      const role = this.isHost ? "Host/Seeder" : "Peer/Leecher";
      const state = this.activeTorrent.done ? "Done" : "Active";
      logger.info(
        `[${role} - ${state}] ` +
          `Progress: ${(this.activeTorrent.progress * 100).toFixed(1)}% ` +
          `(${(this.activeTorrent.downloaded / 1024 / 1024).toFixed(1)} MB) | ` +
          `Peers: ${this.activeTorrent.numPeers} | ` +
          `Download ${(this.activeTorrent.downloadSpeed / 1024).toFixed(0)} KB/s | ` +
          `Upload ${(this.activeTorrent.uploadSpeed / 1024).toFixed(0)} KB/s`,
      );
    }

    if (!force && now - this.lastEmit < 500) {
      return;
    }

    this.lastEmit = now;
    this.emit("progress", {
      progress: this.activeTorrent.progress,
      downloadSpeed: this.activeTorrent.downloadSpeed,
      uploadSpeed: this.activeTorrent.uploadSpeed,
      numPeers: this.activeTorrent.numPeers,
      peerProgress: Object.fromEntries(this.peerProgress),
    });
  }

  broadcast(command: SyncCommand) {
    if (!this.syncSocket || this.syncSocket.readyState !== WebSocket.OPEN) {
      logger.warn("No sync socket connected");
      return;
    }

    this.syncSocket.send(JSON.stringify(command));
  }

  async shutdown() {
    this.closeSyncSocket();
    this.trackerService.stop();

    if (this.server) {
      this.server.close();
      this.server = null;
      this.streamPort = 0;
    }

    if (this.activeTorrent) {
      this.activeTorrent.destroy();
      this.activeTorrent = null;
    }

    if (this.client) {
      this.client.destroy();
      this.client = undefined;
    }

    await this.cloudTorrentService.stop();
    this.cloudStreamPath = "";
  }
}
