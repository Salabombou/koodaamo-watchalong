import { Server } from "bittorrent-tracker";
import localtunnel from "localtunnel";
import logger from "@utilities/logging";
import { startTunnel } from "untun";
import { networkInterfaces } from "os";
import { randomUUID } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { SyncCommand } from "@shared/types";

interface SyncClient {
  socket: WebSocket;
  roomId: string;
  isHost: boolean;
  clientId: string;
}

interface SyncRoom {
  host: WebSocket | null;
  clients: Set<WebSocket>;
}

export class TrackerService {
  private server: Server | null = null;
  private tunnel: localtunnel.Tunnel | null = null;
  private untunTunnel: Awaited<ReturnType<typeof startTunnel>> | null = null;
  private websocketServer: WebSocketServer | null = null;
  private syncRooms: Map<string, SyncRoom> = new Map();
  private clientMetadata: WeakMap<WebSocket, SyncClient> = new WeakMap();
  private syncAccessKey: string | null = null;
  private port: number = 0;
  private tunnelUrl: string | null = null;

  private async probeAnnounceUrl(announceUrl: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(announceUrl, {
        method: "GET",
        signal: controller.signal,
      });
      logger.info(
        `Tracker announce probe response: ${response.status} (${announceUrl})`,
      );
    } catch (error) {
      throw new Error(
        `Tracker announce endpoint is unreachable: ${announceUrl} (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async start(
    type: "lan" | "localtunnel" | "untun" = "localtunnel",
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        // 1. Start the Bittorrent Tracker Server
        this.server = new Server({
          udp: false, // UDP often not supported via HTTP tunnels
          http: true,
          ws: false, // Disable WS to force HTTP polling (standard tracker protocol)
          stats: true,
          // Interval for client announcements (polling frequency)
          interval: 30000,
          filter: (
            infoHash: string,
            params: unknown,
            cb: (err: Error | null) => void,
          ) => {
            // Allow tracking for any torrent
            cb(null);
          },
        });

        // Listen on all interfaces
        this.server.listen(0, "0.0.0.0", async () => {
          const address = this.server?.http.address();
          if (address && typeof address === "object") {
            this.port = address.port;
          } else {
            // Fallback or error if server not started correctly
            this.port = 0;
          }
          logger.info(`Tracker running locally on port ${this.port}`);
          this.setupSyncWebSocketServer();

          try {
            if (type === "lan") {
              const nets = networkInterfaces();
              let ip = "127.0.0.1";
              for (const name of Object.keys(nets)) {
                for (const net of nets[name] || []) {
                  // Skip internal and non-IPv4 addresses
                  if (net.family === "IPv4" && !net.internal) {
                    ip = net.address;
                    // Prefer first non-internal IPv4
                    break;
                  }
                }
                if (ip !== "127.0.0.1") break;
              }
              this.tunnelUrl = `http://${ip}:${this.port}`;
              logger.info(`Tracker accessible on LAN at: ${this.tunnelUrl}`);
            } else if (type === "untun") {
              // Try Cloudflare Quick Tunnel (untun)
              this.untunTunnel = await startTunnel({
                port: this.port,
                acceptCloudflareNotice: true,
              });
              if (!this.untunTunnel) {
                throw new Error("Failed to start Cloudflare Tunnel");
              }
              this.tunnelUrl = await this.untunTunnel.getURL();
              logger.info(
                `Cloudflare Tunnel established at: ${this.tunnelUrl}`,
              );
            } else {
              // Default: LocalTunnel
              // Note: Some public localtunnel servers show interstitial pages.
              // If encountered, consider using a custom server or passing headers if client allows.
              this.tunnel = await localtunnel({ port: this.port });
              this.tunnelUrl = this.tunnel.url;
              logger.info(`Tunnel established at: ${this.tunnelUrl}`);

              this.tunnel.on("close", () => {
                logger.info("Tunnel closed");
                this.tunnelUrl = null;
              });
            }

            const announceUrl = this.getAnnounceUrl();
            if (!announceUrl) {
              throw new Error("Failed to compute tracker announce URL");
            }

            await this.probeAnnounceUrl(announceUrl);
            resolve(announceUrl);
          } catch (err) {
            logger.error("Failed to set up tracker access:", err);
            reject(err);
          }
        });

        this.server.on("error", (err: unknown) => {
          logger.error("Tracker server error:", err);
          reject(err);
        });
      } catch (error) {
        logger.error("Failed to start tracker service", error);
        reject(error);
      }
    });
  }

  setSyncAccessKey(accessKey: string) {
    this.syncAccessKey = accessKey;
  }

  rotateSyncAccessKey(): string {
    const accessKey = randomUUID();
    this.setSyncAccessKey(accessKey);
    return accessKey;
  }

  private setupSyncWebSocketServer() {
    if (!this.server?.http || this.websocketServer) {
      return;
    }

    this.websocketServer = new WebSocketServer({
      noServer: true,
      path: "/watchalong-sync",
    });

    this.server.http.on("upgrade", (request, socket, head) => {
      if (!request.url?.startsWith("/watchalong-sync")) {
        return;
      }

      const parsed = this.parseSyncRequest(request);
      if (!parsed.ok) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.websocketServer!.handleUpgrade(request, socket, head, (ws) => {
        this.websocketServer!.emit("connection", ws, request, parsed.value);
      });
    });

    this.websocketServer.on(
      "connection",
      (socket: WebSocket, _request: IncomingMessage, client: SyncClient) => {
        this.registerSyncClient(socket, client);
      },
    );
  }

  private parseSyncRequest(
    request: IncomingMessage,
  ): { ok: true; value: SyncClient } | { ok: false } {
    if (!request.url || !this.syncAccessKey) {
      return { ok: false };
    }

    const parsedUrl = new URL(request.url, "http://localhost");
    const providedAccessKey = parsedUrl.searchParams.get("accessKey") || "";
    const roomId = parsedUrl.searchParams.get("roomId") || "";
    const role = parsedUrl.searchParams.get("role") || "peer";

    if (
      !providedAccessKey ||
      providedAccessKey !== this.syncAccessKey ||
      !roomId
    ) {
      return { ok: false };
    }

    return {
      ok: true,
      value: {
        socket: null as unknown as WebSocket,
        roomId,
        isHost: role === "host",
        clientId: randomUUID(),
      },
    };
  }

  private getOrCreateRoom(roomId: string): SyncRoom {
    const existing = this.syncRooms.get(roomId);
    if (existing) {
      return existing;
    }

    const room: SyncRoom = { host: null, clients: new Set() };
    this.syncRooms.set(roomId, room);
    return room;
  }

  private registerSyncClient(socket: WebSocket, client: SyncClient) {
    const metadata: SyncClient = {
      ...client,
      socket,
    };

    this.clientMetadata.set(socket, metadata);

    const room = this.getOrCreateRoom(metadata.roomId);
    room.clients.add(socket);

    if (metadata.isHost) {
      room.host = socket;
    }

    socket.on("message", (payload) => {
      this.handleSyncMessage(socket, payload.toString("utf-8"));
    });

    socket.on("close", () => {
      this.removeSyncClient(socket);
    });
  }

  private removeSyncClient(socket: WebSocket) {
    const metadata = this.clientMetadata.get(socket);
    if (!metadata) {
      return;
    }

    const room = this.syncRooms.get(metadata.roomId);
    if (!room) {
      return;
    }

    room.clients.delete(socket);
    if (room.host === socket) {
      room.host = null;
    }

    if (room.clients.size === 0) {
      this.syncRooms.delete(metadata.roomId);
    }
  }

  private handleSyncMessage(sender: WebSocket, rawPayload: string) {
    const metadata = this.clientMetadata.get(sender);
    if (!metadata) {
      return;
    }

    const room = this.syncRooms.get(metadata.roomId);
    if (!room) {
      return;
    }

    let command: SyncCommand;
    try {
      command = JSON.parse(rawPayload) as SyncCommand;
    } catch {
      logger.warn("Invalid sync payload ignored");
      return;
    }

    if (metadata.isHost) {
      const serialized = JSON.stringify(command);
      for (const client of room.clients) {
        if (client === sender || client.readyState !== WebSocket.OPEN) {
          continue;
        }
        client.send(serialized);
      }
      return;
    }

    if (command.type !== "progress" || !room.host) {
      return;
    }

    const hostMessage = JSON.stringify({
      ...command,
      payload: {
        ...(command.payload && typeof command.payload === "object"
          ? command.payload
          : {}),
        peerId: metadata.clientId,
      },
    });

    if (room.host.readyState === WebSocket.OPEN) {
      room.host.send(hostMessage);
    }
  }

  getLocalSyncUrl(roomId: string, accessKey: string, role: "host" | "peer") {
    return `ws://127.0.0.1:${this.port}/watchalong-sync?roomId=${encodeURIComponent(roomId)}&accessKey=${encodeURIComponent(accessKey)}&role=${role}`;
  }

  toRemoteSyncUrl(
    announceUrl: string,
    roomId: string,
    accessKey: string,
    role: "host" | "peer",
  ) {
    const parsed = new URL(announceUrl);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    parsed.pathname = "/watchalong-sync";
    parsed.search = "";
    parsed.searchParams.set("roomId", roomId);
    parsed.searchParams.set("accessKey", accessKey);
    parsed.searchParams.set("role", role);
    return parsed.toString();
  }

  getAnnounceUrl(): string {
    if (!this.tunnelUrl) return "";
    // Use the standard HTTP(S) URL from localtunnel.
    // In Node.js (Electron Main), WebTorrent supports standard HTTP trackers.
    // This uses the polling mechanism instead of persistent WebSockets.
    // IMPORTANT: HTTP trackers usually require the /announce endpoint.
    return `${this.tunnelUrl}/announce`;
  }

  stop() {
    if (this.websocketServer) {
      this.websocketServer.close();
      this.websocketServer = null;
    }

    for (const room of this.syncRooms.values()) {
      for (const client of room.clients) {
        try {
          client.close();
        } catch {
          // ignore shutdown errors
        }
      }
    }
    this.syncRooms.clear();

    if (this.untunTunnel) {
      this.untunTunnel.close();
      this.untunTunnel = null;
    }
    if (this.tunnel) {
      this.tunnel.close();
      this.tunnel = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.tunnelUrl = null;
    this.syncAccessKey = null;
    logger.info("Tracker service stopped");
  }
}
