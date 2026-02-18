declare module "bittorrent-tracker" {
  import { Server as HttpServer } from "http";
  import { Server as HttpsServer } from "https";

  export interface ServerOptions {
    udp?: boolean;
    http?: boolean;
    ws?: boolean;
    stats?: boolean;
    interval?: number;
    filter?: (
      infoHash: string,
      params: unknown,
      cb: (err: Error | null) => void,
    ) => void;
  }

  export class Server {
    http: HttpServer | HttpsServer;
    constructor(options: ServerOptions);
    listen(port: number, hostname?: string, callback?: () => void): void;
    on(event: string, callback: (...args: any[]) => void): void;
    close(callback?: () => void): void;
  }
}

