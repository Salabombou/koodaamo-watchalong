import WebTorrent from "webtorrent";
import { SyncExtension, EXTENSION_NAME } from "../protocol/SyncExtension";
import type { SyncCommand, Wire } from "../protocol/SyncExtension";
import { EventEmitter } from "events";
import rangeParser from "range-parser";
import http from "http";
import type { AddressInfo } from "net";
import nodeDatachannelPolyfill from "node-datachannel/polyfill";
import logger from "../utilities/logging";

const DEFAULT_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.files.fm:7073/announce",
  "wss://tracker.webtorrent.dev",
  "wss://tracker.sloppyta.co:443/announce",
  "wss://open.webtorrent.io",
];

export class TorrentService extends EventEmitter {
  client: WebTorrent.Instance | undefined;
  clientReady: Promise<WebTorrent.Instance>;

  activeTorrent: WebTorrent.Torrent | null = null;
  isHost: boolean = false;
  private extensions: Set<SyncExtension> = new Set();
  private peerProgress: Map<string, number> = new Map();
  private lastEmit: number = 0;
  private lastConsoleLog: number = 0;

  private server: http.Server | null = null;
  private streamPort: number = 0;

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
    if (!this.activeTorrent) {
      res.statusCode = 404;
      res.end("No active torrent");
      return;
    }

    if (!this.activeTorrent || !this.activeTorrent.ready) {
      res.statusCode = 503;
      res.end("Torrent not ready");
      return;
    }

    // Find the video file
    const file = this.activeTorrent.files.find(
      (f: WebTorrent.TorrentFile) =>
        f.name.endsWith(".mp4") ||
        f.name.endsWith(".webm") ||
        f.name.endsWith(".mkv") ||
        f.name.endsWith(".avi"),
    );

    if (!file) {
      res.statusCode = 404;
      res.end("No video file found");
      return;
    }

    file.select(); // Prioritize this file for downloading/streaming

    const rangeHeader = req.headers.range;

    if (!rangeHeader) {
      res.setHeader("Content-Length", file.length);
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");

      const stream = file.createReadStream();
      stream.pipe(res);
      return;
    }

    const parts = rangeParser(file.length, rangeHeader);

    if (parts === -1 || parts === -2) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${file.length}`);
      res.end();
      return;
    }

    const { start, end } = parts[0];
    const chunksize = end - start + 1;

    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${file.length}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", chunksize);
    res.setHeader("Content-Type", "video/mp4");

    const stream = file.createReadStream({ start, end });
    stream.pipe(res);

    stream.on("error", (err: unknown) => {
      logger.error(`Stream error:`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Stream Error");
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
      // @ts-expect-error -- types are wrong, but it does work
      wrtc: nodeDatachannelPolyfill,
      tracker: {
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:global.stun.twilio.com:3478" },
          ],
        },
      },
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

  async seed(filePath: string, userTrackers: string[] = []): Promise<string> {
    const client = await this.clientReady;
    logger.info(`Starting seed for file: ${filePath}`);
    const startTime = Date.now();

    return new Promise((resolve) => {
      //if (this.activeTorrent) this.cleanup();

      const trackers = [...DEFAULT_TRACKERS, ...userTrackers];
      logger.info(`Trackers: ${trackers.join(", ")}`);

      const t = client.seed(
        filePath,
        { announce: trackers },
        (torrent: WebTorrent.Torrent) => {
          logger.info(
            `Torrent creation complete! Took ${(Date.now() - startTime) / 1000}s`,
          );
          logger.info(`Magnet URI: ${torrent.magnetURI}`);
          this.handleTorrent(torrent);
          this.isHost = true;
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
      });

      t.on("error", (err: unknown) => {
        logger.error("Error during seed:", err);
      });
    });
  }

  async add(magnetURI: string): Promise<string> {
    const client = await this.clientReady;
    //if (this.activeTorrent) this.cleanup();

    const torrent = client.add(magnetURI);

    // Handle torrent immediately to ensure wire extensions are registered
    // before the metadata is fully fetched (so the initial handshake includes the extension)
    this.handleTorrent(torrent);
    this.isHost = false;

    return new Promise((resolve) => {
      torrent.on("infoHash", () => {
        resolve(torrent.infoHash);
      });
      // Fallback if infoHash is already there? (unlikely for magnet)
      if (torrent.infoHash) resolve(torrent.infoHash);
    });
  }

  private handleTorrent(torrent: WebTorrent.Torrent) {
    this.activeTorrent = torrent;
    this.extensions.clear();
    this.peerProgress.clear();
    this.lastEmit = 0;

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
      wire.use(EXT);

      wire.on("close", () => {
        logger.info(`Wire disconnected: ${wire.peerId}`);
      });
    });

    // @ts-expect-error - wires might be missing from types --- IGNORE ---
    if (torrent.wires) {
      // @ts-expect-error - wires might be missing from types --- IGNORE ---
      torrent.wires.forEach((wire: Wire) => {
        const remote = `${wire.remoteAddress}:${wire.remotePort}`;
        logger.info(`Attaching to existing wire: ${wire.peerId} (${remote})`);
        wire.use(EXT);

        wire.on("close", () => {
          logger.info(`Wire disconnected: ${wire.peerId}`);
        });
      });
    }

    torrent.on("done", () => {
      logger.info("Torrent download/seed complete");
      this.emitProgress(true);
      this.emit("done");
    });

    const onProgress = () => this.emitProgress();

    torrent.on("download", onProgress);
    torrent.on("upload", onProgress);

    // Emit initial status
    this.emitProgress(true);
  }

  getStreamUrl(): string {
    if (this.streamPort === 0) return "";
    return `http://127.0.0.1:${this.streamPort}/stream`;
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
