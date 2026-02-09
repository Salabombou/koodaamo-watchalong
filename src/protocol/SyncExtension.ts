import { EventEmitter } from "events";
import { Buffer } from "buffer";

export const EXTENSION_NAME = "watchalong_sync";

export interface Wire extends EventEmitter {
  peerId: string;
  extended: (name: string, data: Buffer) => void;
  use(extension: unknown): void;
  [key: string]: unknown;
}

export interface SyncCommand {
  type: "play" | "pause" | "seek" | "chat" | "progress";
  payload: unknown;
  timestamp: number;
}

export class SyncExtension extends EventEmitter {
  protected wire: Wire;
  public name: string = EXTENSION_NAME;
  public isSupported: boolean = false;

  constructor(wire: Wire) {
    super();
    this.wire = wire;
  }

  onHandshake(_infoHash: string, _peerId: string, _extensions: unknown) {
    // Optional: validation
  }

  onExtendedHandshake(handshake: { m?: Record<string, unknown> }) {
    if (!handshake.m || !handshake.m[EXTENSION_NAME]) {
      // Peer does not support this extension
      return;
    }
    this.isSupported = true;
  }

  onMessage(buf: unknown) {
    try {
      // Ensure we have a Buffer, as webtorrent/bittorrent-protocol might return Uint8Array or Array
      const buffer = Buffer.isBuffer(buf)
        ? buf
        : Buffer.from(buf as Uint8Array);
      const str = buffer.toString();
      const command = JSON.parse(str);
      this.emit("command", command);
    } catch (e: unknown) {
      console.error("Failed to parse sync command:", e);
    }
  }

  send(command: SyncCommand) {
    if (!this.isSupported) return;
    try {
      const buf = Buffer.from(JSON.stringify(command));
      // 'this.wire.extended' sends the data.
      // Warning: If the peer hasn't advertised support, this might fail or do nothing.
      this.wire.extended(EXTENSION_NAME, buf);
    } catch (e: unknown) {
      console.error("Failed to send sync command:", e);
    }
  }
}
