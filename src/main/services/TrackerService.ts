import { Server } from "bittorrent-tracker";
import localtunnel from "localtunnel";
import logger from "@utilities/logging";
import { startTunnel } from "untun";
import { networkInterfaces } from "os";

export class TrackerService {
  private server: Server | null = null;
  private tunnel: localtunnel.Tunnel | null = null;
  private untunTunnel: Awaited<ReturnType<typeof startTunnel>> | null = null;
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

  getAnnounceUrl(): string {
    if (!this.tunnelUrl) return "";
    // Use the standard HTTP(S) URL from localtunnel.
    // In Node.js (Electron Main), WebTorrent supports standard HTTP trackers.
    // This uses the polling mechanism instead of persistent WebSockets.
    // IMPORTANT: HTTP trackers usually require the /announce endpoint.
    return `${this.tunnelUrl}/announce`;
  }

  stop() {
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
    logger.info("Tracker service stopped");
  }
}
