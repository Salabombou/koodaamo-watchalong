/* eslint-disable @typescript-eslint/no-explicit-any */
import { Server } from "bittorrent-tracker";
import localtunnel from "localtunnel";
import logger from "../utilities/logging";

export class TrackerService {
  private server: any | null = null;
  private tunnel: localtunnel.Tunnel | null = null;
  private port: number = 0;
  private tunnelUrl: string | null = null;

  async start(): Promise<string> {
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
            params: any,
            cb: (err: Error | null) => void,
          ) => {
            // Allow tracking for any torrent
            cb(null);
          },
        });

        // Listen on a random local port
        this.server.listen(0, "localhost", async () => {
          this.port = (this.server.http.address() as any).port;
          logger.info(`Tracker running locally on port ${this.port}`);

          try {
            // 2. Start LocalTunnel to expose the tracker
            // Note: Some public localtunnel servers show interstitial pages.
            // If encountered, consider using a custom server or passing headers if client allows.
            this.tunnel = await localtunnel({ port: this.port });
            this.tunnelUrl = this.tunnel.url;
            logger.info(`Tunnel established at: ${this.tunnelUrl}`);

            this.tunnel.on("close", () => {
              logger.info("Tunnel closed");
              this.tunnelUrl = null;
            });

            // localtunnel returns http/https, but often we want to advertise ws/wss for webtorrent
            // However, the magnet link tracker URL should generally be HTTP(S) for a standardized announce,
            // or WS(S) if specifically targeting WebTorrent (browser) clients.
            // For universal compatibility, we might want to return the HTTPS URL, and let clients upgrade or handle it.
            // But WebTorrent specifically looks for wss:// for websocket trackers.

            // Return the websocket URL version
            resolve(this.getAnnounceUrl());
          } catch (err) {
            logger.error("Failed to create localtunnel:", err);
            reject(err);
          }
        });

        this.server.on("error", (err: any) => {
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
