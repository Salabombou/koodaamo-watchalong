import WebTorrent from "webtorrent";
import { TrackerService } from "./TrackerService";
import { SyncExtension, EXTENSION_NAME } from "@protocols/SyncExtension";
import type { Wire } from "@protocols/SyncExtension";
import { SyncCommand } from "@shared/types";
import { EventEmitter } from "events";
import rangeParser from "range-parser";
import http from "http";
import path from "path";
import fs from "fs";
import type { AddressInfo } from "net";
import logger from "@utilities/logging";

export class TorrentService extends EventEmitter {
  client: WebTorrent.Instance | undefined;
  clientReady: Promise<WebTorrent.Instance>;

  private trackerService = new TrackerService();

  activeTorrent: WebTorrent.Torrent | null = null;
  isHost: boolean = false;
  private extensions: Set<SyncExtension> = new Set();
  private peerProgress: Map<string, number> = new Map();
  private lastEmit: number = 0;
  private lastConsoleLog: number = 0;

  private server: http.Server | null = null;
  private streamPort: number = 0;

  private static readonly PUBLIC_FALLBACK_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://open.stealth.si:80/announce",
    "https://tracker.opentrackr.org:443/announce",
  ];

  private static readonly TELEMETRY_PREFIX = "[telemetry]";
  private static readonly PEER_WAIT_TIMEOUT_MS = 30000;

  constructor() {
    super();
    this.clientReady = this.initClient();
    this.clientReady.catch((err) => {
      logger.error("Failed to initialize WebTorrent client:", err);
    });
    this.startServer();
  }

  private startServer() {
    this.server = http.createServer((req, res) => {
      // Add CORS headers
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

  private handleHttpCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    if (!this.activeTorrent || !this.activeTorrent.ready) {
      res.statusCode = 503;
      res.end("Torrent not ready");
      return;
    }

    const url = req.url || "/";
    const cleanUrl = decodeURIComponent(url.split("?")[0]);
    let targetPath = cleanUrl;

    // Remove /stream/ prefix if present
    if (targetPath.startsWith("/stream/")) {
      targetPath = targetPath.slice("/stream/".length);
    } else if (targetPath === "/stream") {
      targetPath = "";
    }

    // Find file based on request path
    let file: WebTorrent.TorrentFile | undefined;

    if (targetPath === "" || targetPath === "/") {
      // Default: prioritize m3u8, then video
      file = this.activeTorrent.files.find((f) => f.name.endsWith(".m3u8"));
      if (!file) {
        file = this.activeTorrent.files.find((f) =>
          /\.(mp4|webm|mkv|avi)$/i.test(f.name),
        );
      }
    } else {
      // Match exact filename or path ending with request
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

    // Determine Absolute Path on Disk
    const absPath = path.join(this.activeTorrent.path, file.path);

    // Check if file exists on disk
    if (!fs.existsSync(absPath)) {
      res.statusCode = 404;
      res.end("File not yet downloaded or missing");
      return;
    }

    const stat = fs.statSync(absPath);
    const fileSize = stat.size;

    // Determine Content-Type
    let contentType = "application/octet-stream";
    if (file.name.endsWith(".m3u8"))
      contentType = "application/vnd.apple.mpegurl";
    else if (file.name.endsWith(".ts")) contentType = "video/mp2t";
    else if (file.name.endsWith(".mp4")) contentType = "video/mp4";
    else if (file.name.endsWith(".webm")) contentType = "video/webm";
    else if (file.name.endsWith(".vtt")) contentType = "text/vtt";

    // Handle Range Requests
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

  private getTorrentHashOrUnknown(torrent: WebTorrent.Torrent): string {
    return torrent.infoHash || "unknown";
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
    // For HLS playlists (.m3u8), we must seed the parent directory
    // so peer can fetch .ts segments
    if (filePath.endsWith(".m3u8")) {
      seedPath = path.dirname(filePath);
      logger.info(`Detected HLS playlist. Seeding directory: ${seedPath}`);
    }

    const startTime = Date.now();

    // Start local tracker
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

    const announce = this.buildAnnounceList(
      resolvedTrackerType,
      localTrackerUrl,
    );
    if (announce.length === 0) {
      throw new Error("No valid trackers available for this session");
    }
    logger.info(`Using ${announce.length} tracker(s): ${announce.join(", ")}`);
    this.logTelemetry("seed_trackers_selected", {
      traceId,
      trackerType,
      resolvedTrackerType,
      announce,
    });

    return new Promise((resolve, reject) => {
      //if (this.activeTorrent) this.cleanup();

      let settled = false;

      const t = client.seed(
        seedPath,
        { announce },
        (torrent: WebTorrent.Torrent) => {
          logger.info(
            `Torrent creation complete! Took ${(Date.now() - startTime) / 1000}s`,
          );
          logger.info(`Magnet URI: ${torrent.magnetURI}`);
          this.logTelemetry("seed_ready", {
            traceId,
            trackerType,
            resolvedTrackerType,
            infoHash: torrent.infoHash,
            durationMs: Date.now() - startTime,
          });
          this.handleTorrent(torrent, {
            traceId,
            flow: "seed",
            startedAt: startTime,
            trackerType,
            resolvedTrackerType,
          });
          this.isHost = true;
          settled = true;
          resolve(torrent.magnetURI);
        },
      );

      t.on("infoHash", () => {
        logger.info(
          `InfoHash generated: ${t.infoHash} (Took ${(Date.now() - startTime) / 1000}s)`,
        );
      });

      t.on("metadata", () => {
        logger.info(
          `Metadata ready (Took ${(Date.now() - startTime) / 1000}s)`,
        );
      });

      t.on("warning", (err: unknown) => {
        logger.warn("Warning during seed:", err);
        const message = this.toErrorMessage(err);
        this.logTelemetry("seed_warning", {
          traceId,
          trackerType,
          resolvedTrackerType,
          warning: message,
        });
        if (message.toLowerCase().includes("fetch failed")) {
          logger.warn(
            "Tracker announce request failed. Peer discovery may be reduced until fallback trackers respond.",
          );
        }
      });

      t.on("error", (err: unknown) => {
        logger.error("Error during seed:", err);
        this.logTelemetry("seed_error", {
          traceId,
          trackerType,
          resolvedTrackerType,
          error: this.toErrorMessage(err),
        });
        if (!settled) {
          settled = true;
          reject(
            err instanceof Error ? err : new Error(this.toErrorMessage(err)),
          );
        }
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
      hasTrackerParam: magnetURI.includes("&tr="),
    });

    //if (this.activeTorrent) this.cleanup();

    const torrent = client.add(magnetURI);

    // Handle torrent immediately to ensure wire extensions are registered
    // before the metadata is fully fetched (so the initial handshake includes the extension)
    this.handleTorrent(torrent, {
      traceId,
      flow: "add",
      startedAt,
    });
    this.isHost = false;

    return new Promise((resolve) => {
      torrent.on("infoHash", () => {
        this.logTelemetry("add_infohash", {
          traceId,
          infoHash: torrent.infoHash,
          durationMs: Date.now() - startedAt,
        });
        resolve(torrent.infoHash);
      });

      torrent.on("metadata", () => {
        this.logTelemetry("add_metadata", {
          traceId,
          infoHash: this.getTorrentHashOrUnknown(torrent),
          durationMs: Date.now() - startedAt,
        });
      });

      torrent.on("ready", () => {
        this.logTelemetry("add_ready", {
          traceId,
          infoHash: this.getTorrentHashOrUnknown(torrent),
          durationMs: Date.now() - startedAt,
        });
      });

      torrent.on("warning", (err: unknown) => {
        this.logTelemetry("add_warning", {
          traceId,
          infoHash: this.getTorrentHashOrUnknown(torrent),
          warning: this.toErrorMessage(err),
        });
      });

      torrent.on("error", (err: unknown) => {
        this.logTelemetry("add_error", {
          traceId,
          infoHash: this.getTorrentHashOrUnknown(torrent),
          error: this.toErrorMessage(err),
        });
      });

      // Fallback if infoHash is already there? (unlikely for magnet)
      if (torrent.infoHash) {
        this.logTelemetry("add_infohash", {
          traceId,
          infoHash: torrent.infoHash,
          durationMs: Date.now() - startedAt,
          immediate: true,
        });
        resolve(torrent.infoHash);
      }
    });
  }

  private handleTorrent(
    torrent: WebTorrent.Torrent,
    context?: {
      traceId: string;
      flow: "seed" | "add";
      startedAt: number;
      trackerType?: "lan" | "localtunnel" | "untun";
      resolvedTrackerType?: "lan" | "localtunnel" | "untun";
    },
  ) {
    this.activeTorrent = torrent;
    this.extensions.clear();
    this.peerProgress.clear();
    this.lastEmit = 0;

    let firstPeerLogged = false;
    const firstPeerTimeout = setTimeout(() => {
      if (!context || firstPeerLogged) return;
      this.logTelemetry("peer_wait_timeout", {
        traceId: context.traceId,
        flow: context.flow,
        infoHash: this.getTorrentHashOrUnknown(torrent),
        timeoutMs: TorrentService.PEER_WAIT_TIMEOUT_MS,
        numPeers: torrent.numPeers,
      });
    }, TorrentService.PEER_WAIT_TIMEOUT_MS);

    const maybeLogFirstPeer = (wire: Wire) => {
      if (!context || firstPeerLogged) return;
      firstPeerLogged = true;
      clearTimeout(firstPeerTimeout);
      this.logTelemetry("peer_first_wire", {
        traceId: context.traceId,
        flow: context.flow,
        infoHash: this.getTorrentHashOrUnknown(torrent),
        peerId: wire.peerId,
        remoteAddress: wire.remoteAddress,
        remotePort: wire.remotePort,
        durationMs: Date.now() - context.startedAt,
        trackerType: context.trackerType,
        resolvedTrackerType: context.resolvedTrackerType,
      });
    };

    // Register Extension using a class wrapper to satisfy bittorrent-protocol
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    class EXT extends SyncExtension {
      constructor(wire: Wire) {
        super(wire);
        self.extensions.add(this);
        this.on("command", (cmd: SyncCommand) => {
          if (cmd.type === "progress") {
            const payload = cmd.payload as { percent: number };
            self.peerProgress.set(wire.peerId, payload.percent);
            self.emitProgress();
          } else {
            self.emit("sync-command", cmd);
          }
        });
        wire.on("close", () => {
          self.extensions.delete(this);
          self.peerProgress.delete(wire.peerId);
          self.emitProgress();
        });
      }
    }
    EXT.prototype.name = EXTENSION_NAME;

    // Register for new wires
    torrent.on("wire", (wire: Wire) => {
      const remote = `${wire.remoteAddress}:${wire.remotePort}`;
      logger.info(`New wire connected: ${wire.peerId} (${remote})`);
      maybeLogFirstPeer(wire);
      wire.use(EXT);

      wire.on("close", () => {
        logger.info(`Wire disconnected: ${wire.peerId}`);
      });
    });

    if (torrent.wires) {
      torrent.wires.forEach((wire: Wire) => {
        const remote = `${wire.remoteAddress}:${wire.remotePort}`;
        logger.info(`Attaching to existing wire: ${wire.peerId} (${remote})`);
        maybeLogFirstPeer(wire);
        wire.use(EXT);

        wire.on("close", () => {
          logger.info(`Wire disconnected: ${wire.peerId}`);
        });
      });
    }

    torrent.on("done", () => {
      clearTimeout(firstPeerTimeout);
      logger.info("Torrent download/seed complete");
      this.emitProgress(true);
      this.emit("done");
    });

    torrent.on("close", () => {
      clearTimeout(firstPeerTimeout);
    });

    torrent.on("error", () => {
      clearTimeout(firstPeerTimeout);
    });

    const onProgress = () => this.emitProgress();

    torrent.on("download", onProgress);
    torrent.on("upload", onProgress);

    // Emit initial status
    this.emitProgress(true);
  }

  getStreamUrl(): string {
    if (this.streamPort === 0) return "";
    return `http://127.0.0.1:${this.streamPort}/stream/master.m3u8`;
  }

  private async waitForReady(torrent: WebTorrent.Torrent) {
    if (torrent.ready) return;
    await new Promise<void>((resolve) => {
      torrent.once("ready", () => resolve());
    });
  }

  async handleStreamRequest(request: Request): Promise<Response> {
    if (!this.activeTorrent) {
      return new Response("No active torrent", { status: 404 });
    }

    await this.waitForReady(this.activeTorrent);

    if (!this.activeTorrent || !this.activeTorrent.ready) {
      return new Response("Torrent not ready", { status: 503 });
    }

    const file = this.activeTorrent.files.find(
      (f: WebTorrent.TorrentFile) =>
        f.name.endsWith(".mp4") ||
        f.name.endsWith(".webm") ||
        f.name.endsWith(".mkv") ||
        f.name.endsWith(".avi"),
    );
    if (!file) {
      return new Response("No video file found", { status: 404 });
    }

    const rangeHeader = request.headers.get("Range");

    if (!rangeHeader) {
      const stream = file.createReadStream();
      const readable = new ReadableStream({
        start(controller) {
          stream.on("data", (chunk: unknown) => {
            try {
              controller.enqueue(chunk);
            } catch (_e) {
              (stream as unknown as { destroy: () => void }).destroy();
            }
          });
          stream.on("end", () => {
            try {
              controller.close();
            } catch (_e) {
              /* ignore */
            }
          });
          stream.on("error", (err: unknown) => controller.error(err));
        },
        cancel() {
          (stream as unknown as { destroy: () => void }).destroy();
        },
      });

      return new Response(readable as unknown as BodyInit, {
        headers: {
          "Content-Length": file.length.toString(),
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
        },
      });
    }

    const parts = rangeParser(file.length, rangeHeader);

    if (parts === -1 || parts === -2) {
      return new Response(null, { status: 416 });
    }

    const { start, end } = parts[0];

    const stream = file.createReadStream({ start, end });
    const readable = new ReadableStream({
      start(controller) {
        stream.on("data", (chunk: unknown) => {
          try {
            controller.enqueue(chunk);
          } catch (_e) {
            (stream as unknown as { destroy: () => void }).destroy();
          }
        });
        stream.on("end", () => {
          try {
            controller.close();
          } catch (_e) {
            /* ignore */
          }
        });
        stream.on("error", (err: unknown) => controller.error(err));
      },
      cancel() {
        (stream as unknown as { destroy: () => void }).destroy();
      },
    });

    return new Response(readable as unknown as BodyInit, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${file.length}`,
        "Content-Length": (end - start + 1).toString(),
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
      },
    });
  }

  private emitProgress(force = false) {
    if (!this.activeTorrent) return;

    const now = Date.now();

    // Verbose logging every 3s
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
    if (this.extensions.size === 0) {
      logger.warn("No peers to broadcast to");
    }
    logger.info(
      `Broadcasting ${command.type} to ${this.extensions.size} peers`,
    );
    this.extensions.forEach((ext) => ext.send(command));
  }

  /*cleanup() {
    if (this.mappedPort && this.natClient) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.natClient as any).unmapAll(this.mappedPort, { protocol: "TCP" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.natClient as any).unmapAll(this.mappedPort, { protocol: "UDP" });
        logger.info(`[NAT] Released port ${this.mappedPort}`);
      } catch (_e) {
      }
      this.mappedPort = null;
      this.natClient = null;
    }

    if (this.activeTorrent) {
      this.activeTorrent.destroy();
      this.activeTorrent = null;
    }
    this.extensions.clear();
  }*/
}
