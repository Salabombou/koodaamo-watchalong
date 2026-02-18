import WebTorrent from "webtorrent";
import { Wire as ProtocolWire } from "@protocols/SyncExtension";

declare module "webtorrent" {
  // Use the detailed Wire interface from protocol, since that's what we actually use
  export type Wire = ProtocolWire;

  export interface Torrent {
    wires: Wire[];
    on(event: "wire", callback: (wire: Wire) => void): this;
    on(event: string, callback: (...args: any[]) => void): this;
  }
}
