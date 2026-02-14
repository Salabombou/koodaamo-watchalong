import { PeerConnection, RtcConfig, DataChannel } from "node-datachannel";
import { EventEmitter } from "events";
import { Signal } from "../protocol/SignalingExtension";
import logger from "../utilities/logging";

export interface SyncCommand {
  type: "play" | "pause" | "seek" | "chat" | "progress";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  timestamp: number;
}

const ICE_SERVERS = ["stun:stun.l.google.com:19302"];

export class SyncService extends EventEmitter {
  private peers: Map<string, PeerConnection> = new Map();
  private dataChannels: Map<string, DataChannel> = new Map();
  private signalCallbacks: Map<string, (signal: Signal) => void> = new Map();

  constructor() {
    super();
  }

  public addPeer(
    peerId: string,
    isInitiator: boolean,
    sendSignal: (signal: Signal) => void,
  ) {
    if (this.peers.has(peerId)) {
      logger.warn(`Peer ${peerId} already exists in SyncService`);
      return;
    }

    logger.info(
      `Initializing P2P connection for ${peerId} (Initiator: ${isInitiator})`,
    );

    const config: RtcConfig = {
      iceServers: ICE_SERVERS,
    };

    const pc = new PeerConnection(peerId, config);

    this.peers.set(peerId, pc);
    this.signalCallbacks.set(peerId, sendSignal);

    pc.onLocalDescription((sdp, type) => {
      logger.info(`[P2P] Sending ${type} to ${peerId}`);
      sendSignal({ type: type as "offer" | "answer", sdp });
    });

    pc.onLocalCandidate((candidate, mid) => {
      // logger.info(`[P2P] Sending candidate to ${peerId}`);
      // reduce noise
      sendSignal({ type: "candidate", candidate, mid });
    });

    pc.onStateChange((state) => {
      logger.info(`[P2P] Connection state for ${peerId}: ${state}`);
      if (
        state === "disconnected" ||
        state === "failed" ||
        state === "closed"
      ) {
        this.cleanupPeer(peerId);
      }
    });

    if (isInitiator) {
      const dc = pc.createDataChannel("watchalong-sync");
      this.setupDataChannel(peerId, dc);
    } else {
      pc.onDataChannel((dc) => {
        logger.info(`[P2P] Received DataChannel from ${peerId}`);
        this.setupDataChannel(peerId, dc);
      });
    }
  }

  public handleSignal(peerId: string, signal: Signal) {
    const pc = this.peers.get(peerId);
    if (!pc) {
      logger.warn(
        `Received signal for unknown peer ${peerId}. Signal type: ${signal.type}`,
      );
      return;
    }

    try {
      if (signal.type === "offer") {
        logger.info(`[P2P] Received offer from ${peerId}`);
        pc.setRemoteDescription(signal.sdp!, "offer");
      } else if (signal.type === "answer") {
        logger.info(`[P2P] Received answer from ${peerId}`);
        pc.setRemoteDescription(signal.sdp!, "answer");
      } else if (signal.type === "candidate") {
        pc.addRemoteCandidate(signal.candidate!, signal.mid!);
      }
    } catch (error) {
      logger.error(`[P2P] Error handling signal from ${peerId}:`, error);
    }
  }

  public broadcast(command: SyncCommand) {
    const msg = JSON.stringify(command);
    let count = 0;
    this.dataChannels.forEach((dc) => {
      if (dc.isOpen()) {
        try {
          dc.sendMessage(msg);
          count++;
        } catch (e) {
          logger.error("Failed to send message", e);
        }
      }
    });
    logger.info(`Broadcasted ${command.type} to ${count} peers`);
  }

  private setupDataChannel(peerId: string, dc: DataChannel) {
    dc.onOpen(() => {
      logger.info(`[P2P] DataChannel OPEN for ${peerId}`);
      this.dataChannels.set(peerId, dc);
    });

    dc.onMessage((msg) => {
      try {
        const str = Buffer.isBuffer(msg) ? msg.toString() : (msg as string);
        const command = JSON.parse(str) as SyncCommand;
        this.emit("command", command, peerId);
      } catch (e) {
        logger.error(`[P2P] Failed to parse message from ${peerId}`, e);
      }
    });

    dc.onError((msg) => {
      logger.error(`[P2P] DataChannel error for ${peerId}: ${msg}`);
    });

    // There isn't always a specialized 'close' event on DC in node-datachannel,
    // relying on PC state change or explicit checks is safer, but let's check docs if needed.
    // For now, we rely on PC disconnect to cleanup.
  }

  private cleanupPeer(peerId: string) {
    if (this.peers.has(peerId)) {
      const pc = this.peers.get(peerId);
      // close/destroy if method exists
      try {
        pc?.close();
      } catch (_e) {
        /* ignore */
      }
      this.peers.delete(peerId);
    }
    if (this.dataChannels.has(peerId)) {
      this.dataChannels.delete(peerId);
    }
    this.signalCallbacks.delete(peerId);
    logger.info(`[P2P] Cleaned up peer ${peerId}`);
  }
}
