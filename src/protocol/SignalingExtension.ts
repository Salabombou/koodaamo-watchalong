import { EventEmitter } from "events";
import { Buffer } from "buffer";

export const EXTENSION_NAME = "watchalong_signaling";

export interface Wire extends EventEmitter {
  peerId: string;
  extended: (name: string, data: Buffer) => void;
  use(extension: unknown): void;
  [key: string]: unknown;
}

export interface Signal {
  type: "offer" | "answer" | "candidate";
  sdp?: string;
  candidate?: string;
  mid?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export class SignalingExtension extends EventEmitter {
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
    this.emit("supported");
  }

  onMessage(buf: unknown) {
    try {
      // Ensure we have a Buffer
      const buffer = Buffer.isBuffer(buf)
        ? buf
        : Buffer.from(buf as Uint8Array);
      const str = buffer.toString();
      const signal = JSON.parse(str);
      this.emit("signal", signal);
    } catch (e: unknown) {
      console.error("Failed to parse signal:", e);
    }
  }

  send(signal: Signal) {
    if (!this.isSupported) return;
    try {
      const buf = Buffer.from(JSON.stringify(signal));
      this.wire.extended(EXTENSION_NAME, buf);
    } catch (e: unknown) {
      console.error("Failed to send signal:", e);
    }
  }
}
