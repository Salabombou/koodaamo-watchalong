import type WebTorrent from "webtorrent";
import { SyncExtension, EXTENSION_NAME } from "../protocol/SyncExtension";
import type { SyncCommand, Wire } from "../protocol/SyncExtension";
import { EventEmitter } from "events";
import rangeParser from "range-parser";
// import wrtc from "@roamhq/wrtc";
import http from "http";
import type { AddressInfo } from "net";

const DEFAULT_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
  "wss://tracker.files.fm:7073/announce",
  "wss://tracker.webtorrent.dev",
];

export class TorrentService extends EventEmitter {
  client: WebTorrent.Instance | undefined;
  clientReady: Promise<WebTorrent.Instance>;

  activeTorrent: WebTorrent.Torrent | null = null;
  isHost: boolean = false;
  private extensions: Set<SyncExtension> = new Set();
  private peerProgress: Map<string, number> = new Map();
  private natClient: unknown = null;
  private mappedPort: number | null = null;
  private lastEmit: number = 0;

  private server: http.Server | null = null;
  private streamPort: number = 0;

  constructor() {
    super();
    this.clientReady = this.initClient();
    this.clientReady.catch((err) => {
      console.error("Failed to initialize WebTorrent client:", err);
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
      console.log(
        `[TorrentService] Stream server listening on http://127.0.0.1:${this.streamPort}`,
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
      console.error("Stream error:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Stream Error");
      }
    });
  }

  private async initClient() {
    const { default: WebTorrentClass } = await import("webtorrent");

    let wtrc: typeof import("@roamhq/wrtc") | null = null;
    try {
      wtrc = await import("@roamhq/wrtc");
    } catch (e: unknown) {
      console.warn(
        "Failed to load @roamhq/wrtc, WebRTC support will be unavailable:",
        e,
      );
    }

    this.client = new WebTorrentClass({
      utp: true,
      dht: true, // Enable DHT for better peer discovery without trackers
      tracker: {
        wrtc: wtrc,
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
      console.error("WebTorrent Client Error:", err);
      this.emit("error", err);
    });

    this.client.on("torrent", (torrent) => {
      console.log("Torrent added:", torrent.infoHash);
      this.setupConnectivity();
    });

    return this.client!;
  }

  private async setupConnectivity() {
    if (!this.client) return;

    // @ts-expect-error - address might be missing from types
    const port = this.client.address().port;
    console.log(`[TorrentService] Client listening on port ${port}`);

    try {
      const { upnpNat } = await import("@achingbrain/nat-port-mapper");
      const client = upnpNat();

      // Find a gateway (this is an async generator)
      for await (const gateway of client.findGateways({
        signal: AbortSignal.timeout(10000),
      })) {
        try {
          // Map TCP
          await gateway.mapAll(port, {
            externalPort: port,
            protocol: "TCP",
            ttl: 3600,
            description: "WatchAlong-P2P",
          });

          // Map UDP
          await gateway.mapAll(port, {
            externalPort: port,
            protocol: "UDP",
            ttl: 3600,
            description: "WatchAlong-P2P-UDP",
          });

          this.mappedPort = port;
          this.natClient = gateway;
          console.log(`[NAT] UPnP Port Mapping successful: ${port} (TCP/UDP)`);

          // Try to get external IP
          try {
            const externalIp = await gateway.externalIp();
            console.log(`[NAT] External IP: ${externalIp}`);
          } catch (_e) {
            /* ignore */
          }

          break; // Stop searching if successful
        } catch (err: unknown) {
          console.warn("[NAT] UPnP Mapping failed:", err);
        }
      }
    } catch (e: unknown) {
      console.error("[NAT] Setup error:", e);
    }
  }

  async seed(filePath: string, userTrackers: string[] = []): Promise<string> {
    const client = await this.clientReady;
    console.log(`[TorrentService] Starting seed for file: ${filePath}`);
    const startTime = Date.now();

    return new Promise((resolve) => {
      if (this.activeTorrent) this.cleanup();

      const trackers = [...DEFAULT_TRACKERS, ...userTrackers];
      console.log(`[TorrentService] Trackers: ${trackers.join(", ")}`);

      const t = client.seed(
        filePath,
        { announce: trackers },
        (torrent: WebTorrent.Torrent) => {
          console.log(
            `[TorrentService] Torrent creation complete! Took ${(Date.now() - startTime) / 1000}s`,
          );
          console.log(`[TorrentService] Magnet URI: ${torrent.magnetURI}`);
          this.handleTorrent(torrent);
          this.isHost = true;
          resolve(torrent.magnetURI);
        },
      );

      t.on("infoHash", () => {
        console.log(
          `[TorrentService] InfoHash generated: ${t.infoHash} (Took ${(Date.now() - startTime) / 1000}s)`,
        );
      });

      t.on("metadata", () => {
        console.log(
          `[TorrentService] Metadata ready (Took ${(Date.now() - startTime) / 1000}s)`,
        );
      });

      t.on("warning", (err) => {
        console.warn("[TorrentService] Warning during seed:", err);
      });

      t.on("error", (err) => {
        console.error("[TorrentService] Error during seed:", err);
      });
    });
  }

  async add(magnetURI: string): Promise<string> {
    const client = await this.clientReady;
    if (this.activeTorrent) this.cleanup();

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
      console.log("[TorrentService] New wire connected:", wire.peerId);
      wire.use(EXT);
    });

    // @ts-expect-error - wires property exists on Torrent
    if (torrent.wires) {
      // @ts-expect-error - wires is array
      torrent.wires.forEach((wire: Wire) => {
        console.log(
          "[TorrentService] Attaching to existing wire:",
          wire.peerId,
        );
        wire.use(EXT);
      });
    }

    torrent.on("done", () => {
      console.log("[TorrentService] Torrent download/seed complete");
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

  async handleStreamRequest(request: Request): Promise<Response> {
    if (!this.activeTorrent) {
      return new Response("No active torrent", { status: 404 });
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
      console.warn("[TorrentService] No peers to broadcast to");
    }
    console.log(
      `[TorrentService] Broadcasting ${command.type} to ${this.extensions.size} peers`,
    );
    this.extensions.forEach((ext) => ext.send(command));
  }

  cleanup() {
    if (this.mappedPort && this.natClient) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.natClient as any).unmapAll(this.mappedPort, { protocol: "TCP" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.natClient as any).unmapAll(this.mappedPort, { protocol: "UDP" });
        console.log(`[NAT] Released port ${this.mappedPort}`);
      } catch (_e) {
        /* ignore */
      }
      this.mappedPort = null;
      this.natClient = null;
    }

    if (this.activeTorrent) {
      this.activeTorrent.destroy();
      this.activeTorrent = null;
    }
    this.extensions.clear();
  }
}
