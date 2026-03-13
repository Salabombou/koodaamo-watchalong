import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";
import rangeParser from "range-parser";
import crypto from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { AddressInfo } from "net";
import { app } from "electron";

import { SyncCommand, RoomProgress, HostAccessMode } from "@shared/types";
import logger from "@utilities/logging";

interface SyncEnvelope {
  id: number;
  senderId: string;
  command: SyncCommand;
  createdAt: number;
}

interface RoomFileEntry {
  path: string;
  size: number;
}

interface RoomManifest {
  roomCode: string;
  defaultStreamFile: string;
  files: RoomFileEntry[];
}

interface HostedRoom {
  roomCode: string;
  streamRoot: string;
  defaultStreamFile: string;
  events: SyncEnvelope[];
  nextEventId: number;
  peerProgress: Map<string, number>;
  peerLastSeen: Map<string, number>;
}

interface DownloadedRoom {
  roomCode: string;
  streamRoot: string;
  defaultStreamFile: string;
}

interface ActiveSession {
  roomCode: string;
  remoteBaseUrl: string;
  isHost: boolean;
  clientId: string;
  stopPolling: boolean;
  pollCursor: number;
  localStreamRoot: string;
  defaultStreamFile: string;
  pollAbortController?: AbortController;
}

interface ActiveTunnel {
  mode: Exclude<HostAccessMode, "lan">;
  url: string;
  close: () => Promise<void> | void;
}

export class RoomService extends EventEmitter {
  isHost = false;

  private server: http.Server | null = null;
  private streamPort = 0;
  private hostedRoom: HostedRoom | null = null;
  private downloadedRooms = new Map<string, DownloadedRoom>();
  private activeSession: ActiveSession | null = null;
  private activeTunnel: ActiveTunnel | null = null;

  constructor() {
    super();
    this.startServer();
  }

  async hostRoom(filePath: string, hostAccessMode: HostAccessMode): Promise<string> {
    if (!this.server || this.streamPort === 0) {
      throw new Error("Host server is not ready");
    }

    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error("Segmented stream path does not exist");
    }

    const streamRoot = this.resolveStreamRoot(absolutePath);
    const defaultStreamFile = this.resolveDefaultStreamFile(absolutePath);
    const roomCode = this.createRoomCode();

    await this.closeActiveTunnel();

    this.hostedRoom = {
      roomCode,
      streamRoot,
      defaultStreamFile,
      events: [],
      nextEventId: 1,
      peerProgress: new Map(),
      peerLastSeen: new Map(),
    };

    this.isHost = true;

    try {
      const host = await this.resolveShareableHost(hostAccessMode);

      this.activeSession = {
        roomCode,
        remoteBaseUrl: this.getLocalBaseUrl(),
        isHost: true,
        clientId: crypto.randomUUID(),
        stopPolling: false,
        pollCursor: 0,
        localStreamRoot: streamRoot,
        defaultStreamFile,
      };

      this.emitProgress({ progress: 1, numPeers: 0, peerProgress: {} });
      this.emit("done");

      const invite = `koodaamo-watchalong:///?room-code=${encodeURIComponent(roomCode)}&host=${encodeURIComponent(host)}`;

      logger.info(`Room ${roomCode} created with root ${streamRoot}`);
      return invite;
    } catch (error) {
      await this.closeActiveTunnel();
      this.isHost = false;
      this.hostedRoom = null;
      this.activeSession = null;
      throw error;
    }
  }

  async joinRoom(inviteUrl: string): Promise<string> {
    await this.closeActiveTunnel();

    const { roomCode, baseUrl } = this.parseInvite(inviteUrl);

    this.isHost = false;
    this.activeSession = {
      roomCode,
      remoteBaseUrl: baseUrl,
      isHost: false,
      clientId: crypto.randomUUID(),
      stopPolling: false,
      pollCursor: 0,
      localStreamRoot: "",
      defaultStreamFile: "",
    };

    const manifest = await this.fetchRoomManifestOrThrow(roomCode, baseUrl);
    const localRoot = await this.downloadRoomFiles(manifest, baseUrl);

    this.activeSession.localStreamRoot = localRoot;
    this.activeSession.defaultStreamFile = manifest.defaultStreamFile;

    this.downloadedRooms.set(roomCode, {
      roomCode,
      streamRoot: localRoot,
      defaultStreamFile: manifest.defaultStreamFile,
    });

    this.emitProgress({ progress: 1, numPeers: 0, peerProgress: {} });
    this.emit("done");

    void this.startLongPollingLoop();
    return roomCode;
  }

  getRoomStreamUrl(): string {
    const session = this.activeSession;
    if (!session) {
      throw new Error("No active room session");
    }

    if (session.isHost) {
      return `${this.getLocalBaseUrl()}/api/rooms/${encodeURIComponent(session.roomCode)}/stream/${encodeURIComponent(session.defaultStreamFile)}`;
    }

    if (!session.localStreamRoot || !session.defaultStreamFile) {
      throw new Error("Room files are not downloaded yet");
    }

    return `${this.getLocalBaseUrl()}/local/rooms/${encodeURIComponent(session.roomCode)}/stream/${encodeURIComponent(session.defaultStreamFile)}`;
  }

  async sendSyncCommand(command: SyncCommand): Promise<void> {
    const session = this.activeSession;
    if (!session) {
      throw new Error("No active room session");
    }

    if (session.isHost) {
      this.appendEvent(session.clientId, command);
      return;
    }

    const endpoint = `${session.remoteBaseUrl}/api/rooms/${encodeURIComponent(session.roomCode)}/sync`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        senderId: session.clientId,
        command,
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Failed to send sync event (${response.status})`);
    }
  }

  async shutdown(): Promise<void> {
    if (this.activeSession) {
      this.activeSession.stopPolling = true;
      if (this.activeSession.pollAbortController) {
        this.activeSession.pollAbortController.abort();
      }
      this.activeSession = null;
    }

    this.hostedRoom = null;
    await this.closeActiveTunnel();

    if (this.server) {
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
      this.server = null;
      this.streamPort = 0;
    }
  }

  private startServer() {
    this.server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Range,Origin,Accept,Authorization",
      );
      res.setHeader(
        "Access-Control-Expose-Headers",
        "Content-Length,Content-Range,Accept-Ranges,Content-Type",
      );
      res.setHeader("Access-Control-Max-Age", "86400");

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      void this.handleRequest(req, res);
    });

    this.server.listen(0, "0.0.0.0", () => {
      const address = this.server?.address() as AddressInfo;
      this.streamPort = address.port;
      logger.info(`Room API listening on ${this.getLocalBaseUrl()}`);
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname.startsWith("/local/rooms/")) {
        this.handleLocalStreamRequest(req, res, pathname);
        return;
      }

      if (!pathname.startsWith("/api/rooms/")) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const room = this.hostedRoom;
      if (!room) {
        res.statusCode = 404;
        res.end("No hosted room");
        return;
      }

      const roomPrefix = `/api/rooms/${encodeURIComponent(room.roomCode)}`;
      if (!pathname.startsWith(roomPrefix)) {
        res.statusCode = 404;
        res.end("Room not found");
        return;
      }

      if (pathname === `${roomPrefix}/status` && req.method === "GET") {
        this.writeJson(res, {
          roomCode: room.roomCode,
          peers: this.getActivePeerCount(),
          ready: true,
        });
        return;
      }

      if (pathname === `${roomPrefix}/files` && req.method === "GET") {
        this.writeJson(res, this.buildRoomManifest(room));
        return;
      }

      if (pathname === `${roomPrefix}/sync` && req.method === "GET") {
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        const timeout = Number(url.searchParams.get("timeout") ?? "25");
        const clientId = url.searchParams.get("clientId") ?? "unknown";

        room.peerLastSeen.set(clientId, Date.now());

        const events = await this.waitForEvents(cursor, timeout);
        const nextCursor = events.length > 0 ? events[events.length - 1].id : cursor;

        this.writeJson(res, {
          events,
          nextCursor,
        });
        return;
      }

      if (pathname === `${roomPrefix}/sync` && req.method === "POST") {
        const body = await this.readJson(req);
        const senderId = String(body.senderId ?? "unknown");
        const command = body.command as SyncCommand;

        this.appendEvent(senderId, command);
        this.writeJson(res, { ok: true });
        return;
      }

      if (pathname === `${roomPrefix}/stream` && req.method === "GET") {
        this.streamFromRoot(req, res, room.streamRoot, room.defaultStreamFile);
        return;
      }

      if (pathname.startsWith(`${roomPrefix}/stream/`) && req.method === "GET") {
        const relative = pathname.slice(`${roomPrefix}/stream/`.length);
        this.streamFromRoot(req, res, room.streamRoot, relative);
        return;
      }

      res.statusCode = 404;
      res.end("Not found");
    } catch (error) {
      logger.error("Request handler error", error);
      res.statusCode = 500;
      res.end("Internal server error");
    }
  }

  private handleLocalStreamRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ) {
    const marker = "/stream";
    const markerIndex = pathname.indexOf(marker);
    if (markerIndex === -1) {
      res.statusCode = 404;
      res.end("Local stream not found");
      return;
    }

    const roomPrefix = pathname.slice(0, markerIndex);
    const roomCode = decodeURIComponent(roomPrefix.replace("/local/rooms/", "")).trim();
    if (!roomCode) {
      res.statusCode = 404;
      res.end("Room code missing");
      return;
    }

    const room = this.downloadedRooms.get(roomCode);
    if (!room) {
      res.statusCode = 404;
      res.end("Downloaded room not found");
      return;
    }

    const suffix = pathname.slice(markerIndex + marker.length);
    const relativePath = suffix === "" || suffix === "/" ? room.defaultStreamFile : suffix.replace(/^\//, "");

    this.streamFromRoot(req, res, room.streamRoot, relativePath);
  }

  private streamFromRoot(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    rootPath: string,
    relativePath: string,
  ) {
    const normalizedRoot = path.resolve(rootPath);
    const normalizedRelativePath = relativePath.replace(/^\/+/, "");
    const absolutePath = path.resolve(normalizedRoot, normalizedRelativePath);

    if (!absolutePath.startsWith(normalizedRoot)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(absolutePath)) {
      res.statusCode = 404;
      res.end("File not found");
      return;
    }

    const stat = fs.statSync(absolutePath);
    const fileSize = stat.size;

    let contentType = "application/octet-stream";
    if (absolutePath.endsWith(".m3u8")) contentType = "application/vnd.apple.mpegurl";
    else if (absolutePath.endsWith(".ts")) contentType = "video/mp2t";
    else if (absolutePath.endsWith(".mp4")) contentType = "video/mp4";
    else if (absolutePath.endsWith(".webm")) contentType = "video/webm";
    else if (absolutePath.endsWith(".vtt")) contentType = "text/vtt";
    else if (absolutePath.endsWith(".json")) contentType = "application/json";

    const rangeHeader = req.headers.range;

    if (!rangeHeader) {
      res.setHeader("Content-Length", fileSize);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Accept-Ranges", "bytes");
      fs.createReadStream(absolutePath).pipe(res);
      return;
    }

    const parts = rangeParser(fileSize, rangeHeader);
    if (parts === -1 || parts === -2 || !Array.isArray(parts)) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      res.end();
      return;
    }

    const { start, end } = parts[0];
    const chunkSize = end - start + 1;

    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", chunkSize);
    res.setHeader("Content-Type", contentType);

    fs.createReadStream(absolutePath, { start, end }).pipe(res);
  }

  private async fetchRoomManifestOrThrow(roomCode: string, remoteBaseUrl: string) {
    const response = await fetch(
      `${remoteBaseUrl}/api/rooms/${encodeURIComponent(roomCode)}/files`,
    );

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || "Failed to get room files manifest");
    }

    return (await response.json()) as RoomManifest;
  }

  private async downloadRoomFiles(manifest: RoomManifest, remoteBaseUrl: string) {
    const downloadRoot = path.join(app.getPath("userData"), "rooms-cache", manifest.roomCode);
    fs.rmSync(downloadRoot, { recursive: true, force: true });
    fs.mkdirSync(downloadRoot, { recursive: true });

    const totalBytes = manifest.files.reduce((sum, entry) => sum + entry.size, 0);
    let downloadedBytes = 0;
    const startedAt = Date.now();

    this.emitProgress({
      progress: totalBytes === 0 ? 1 : 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      peerProgress: {},
    });

    for (const file of manifest.files) {
      const encodedPath = file.path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      const sourceUrl = `${remoteBaseUrl}/api/rooms/${encodeURIComponent(manifest.roomCode)}/stream/${encodedPath}`;
      const targetPath = path.join(downloadRoot, file.path);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      await this.downloadFile(sourceUrl, targetPath, (chunkBytes) => {
        downloadedBytes += chunkBytes;
        const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
        this.emitProgress({
          progress: totalBytes > 0 ? Math.min(downloadedBytes / totalBytes, 1) : 1,
          downloadSpeed: downloadedBytes / elapsedSeconds,
          uploadSpeed: 0,
          numPeers: 0,
          peerProgress: {},
        });
      });
    }

    return downloadRoot;
  }

  private async downloadFile(
    sourceUrl: string,
    targetPath: string,
    onChunk: (bytes: number) => void,
  ) {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Failed to download ${sourceUrl}`);
    }

    if (!response.body) {
      const content = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(targetPath, content);
      onChunk(content.length);
      return;
    }

    const stream = Readable.fromWeb(
      response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );
    stream.on("data", (chunk: Buffer) => {
      onChunk(chunk.length);
    });

    await pipeline(stream, fs.createWriteStream(targetPath));
  }

  private buildRoomManifest(room: HostedRoom): RoomManifest {
    return {
      roomCode: room.roomCode,
      defaultStreamFile: room.defaultStreamFile,
      files: this.listFilesRecursively(room.streamRoot),
    };
  }

  private listFilesRecursively(rootPath: string, currentRelativePath = ""): RoomFileEntry[] {
    const currentAbsolutePath = path.join(rootPath, currentRelativePath);
    const entries = fs.readdirSync(currentAbsolutePath, { withFileTypes: true });
    const output: RoomFileEntry[] = [];

    for (const entry of entries) {
      const relativePath = currentRelativePath
        ? `${currentRelativePath}/${entry.name}`
        : entry.name;
      const normalizedRelativePath = relativePath.replace(/\\/g, "/");

      if (entry.isDirectory()) {
        output.push(...this.listFilesRecursively(rootPath, normalizedRelativePath));
        continue;
      }

      const absolutePath = path.join(rootPath, normalizedRelativePath);
      const stats = fs.statSync(absolutePath);
      output.push({
        path: normalizedRelativePath,
        size: stats.size,
      });
    }

    output.sort((left, right) => left.path.localeCompare(right.path));
    return output;
  }

  private appendEvent(senderId: string, command: SyncCommand) {
    const room = this.hostedRoom;
    if (!room) return;

    const envelope: SyncEnvelope = {
      id: room.nextEventId,
      senderId,
      command,
      createdAt: Date.now(),
    };

    room.nextEventId += 1;
    room.events.push(envelope);

    if (room.events.length > 5000) {
      room.events = room.events.slice(-2000);
    }

    if (command.type === "progress" && command.payload?.percent !== undefined) {
      const percent = Number(command.payload.percent);
      if (Number.isFinite(percent)) {
        room.peerProgress.set(senderId, percent);
        this.emitProgress({
          progress: 1,
          numPeers: this.getActivePeerCount(),
          peerProgress: Object.fromEntries(room.peerProgress.entries()),
        });
      }
    }

    this.emit("sync-command", command);
  }

  private async waitForEvents(cursor: number, timeoutSeconds: number) {
    const room = this.hostedRoom;
    if (!room) return [] as SyncEnvelope[];

    const clampedTimeout = Math.max(1, Math.min(timeoutSeconds, 30));
    let timeoutId: NodeJS.Timeout;

    return new Promise<SyncEnvelope[]>((resolve) => {
      const checkEvents = () => {
        const events = room.events.filter((event) => event.id > cursor);
        if (events.length > 0) {
          cleanup();
          resolve(events);
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.removeListener("sync-command", checkEvents);
      };

      timeoutId = setTimeout(() => {
        cleanup();
        resolve([]);
      }, clampedTimeout * 1000);

      this.on("sync-command", checkEvents);
      
      // Initial check in case events were already added
      checkEvents();
    });
  }

  private async startLongPollingLoop() {
    const session = this.activeSession;
    if (!session) return;

    session.pollAbortController = new AbortController();

    while (!session.stopPolling) {
      try {
        const endpoint = `${session.remoteBaseUrl}/api/rooms/${encodeURIComponent(session.roomCode)}/sync?cursor=${session.pollCursor}&timeout=25&clientId=${encodeURIComponent(session.clientId)}`;
        const response = await fetch(endpoint, {
          signal: session.pollAbortController.signal,
        });
        if (!response.ok) {
          const message = await response.text();
          throw new Error(message || `Long poll failed with ${response.status}`);
        }

        const payload = (await response.json()) as {
          events: SyncEnvelope[];
          nextCursor: number;
        };

        session.pollCursor = payload.nextCursor;

        for (const event of payload.events) {
          if (event.senderId === session.clientId) continue;
          this.emit("sync-command", event.command);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          logger.info("Long polling aborted");
          break;
        }
        logger.warn("Long poll failed, retrying", error);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  private parseInvite(inviteUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(inviteUrl);
    } catch {
      throw new Error("Invalid invite URL");
    }

    if (parsed.protocol !== "koodaamo-watchalong:") {
      throw new Error("Invite must use koodaamo-watchalong:// protocol");
    }

    const roomCode = parsed.searchParams.get("room-code");
    const host = parsed.searchParams.get("host");

    if (!roomCode || !host) {
      throw new Error("Invite is missing room-code or host");
    }

    const normalizedHost =
      host.startsWith("http://") || host.startsWith("https://")
        ? host
        : `http://${host}`;

    this.assertAllowedHost(normalizedHost);

    return {
      roomCode,
      baseUrl: normalizedHost.replace(/\/$/, ""),
    };
  }

  private assertAllowedHost(rawHost: string) {
    let parsedHost: URL;
    try {
      parsedHost = new URL(rawHost);
    } catch {
      throw new Error("Invite host is invalid");
    }

    const protocol = parsedHost.protocol;
    const hostname = parsedHost.hostname.toLowerCase();

    const isLocalHost =
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    const isLocalName = hostname.endsWith(".local");
    const isPrivateIPv4 = this.isPrivateIPv4(hostname);

    const isTryCloudflare =
      hostname === "trycloudflare.com" || hostname.endsWith(".trycloudflare.com");
    const isLocalTunnel =
      hostname === "loca.lt" ||
      hostname.endsWith(".loca.lt") ||
      hostname === "localtunnel.me" ||
      hostname.endsWith(".localtunnel.me");

    if (protocol === "http:") {
      if (isLocalHost || isLocalName || isPrivateIPv4) {
        return;
      }

      throw new Error(
        "HTTP hosts must be local/private network addresses (localhost, .local, RFC1918)",
      );
    }

    if (protocol === "https:") {
      if (isLocalHost || isLocalName || isPrivateIPv4 || isTryCloudflare || isLocalTunnel) {
        return;
      }

      throw new Error(
        "HTTPS hosts must be trycloudflare or localtunnel domains (or local/private hosts)",
      );
    }

    throw new Error("Invite host protocol must be http or https");
  }

  private isPrivateIPv4(hostname: string) {
    const parts = hostname.split(".");
    if (parts.length !== 4) return false;

    const octets = parts.map((value) => Number(value));
    if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      return false;
    }

    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 127) return true;

    return false;
  }

  private resolveStreamRoot(inputPath: string) {
    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      return inputPath;
    }

    if (inputPath.endsWith(".m3u8")) {
      return path.dirname(inputPath);
    }

    return path.dirname(inputPath);
  }

  private resolveDefaultStreamFile(inputPath: string) {
    const stat = fs.statSync(inputPath);
    if (!stat.isDirectory()) {
      return path.basename(inputPath);
    }

    const candidates = fs.readdirSync(inputPath);
    const master = candidates.find((item) => item === "master.m3u8");
    if (master) return master;

    const anyPlaylist = candidates.find((item) => item.endsWith(".m3u8"));
    if (anyPlaylist) return anyPlaylist;

    const anyVideo = candidates.find((item) => /(mp4|webm|mkv)$/i.test(item));
    if (anyVideo) return anyVideo;

    throw new Error("Could not find a streamable media file in output folder");
  }

  private getLocalBaseUrl() {
    return `http://127.0.0.1:${this.streamPort}`;
  }

  private async resolveShareableHost(hostAccessMode: HostAccessMode) {
    const lanHost = `${this.getLanAddress()}:${this.streamPort}`;

    if (hostAccessMode === "lan") {
      return lanHost;
    }

    if (hostAccessMode === "localtunnel") {
      return this.startLocaltunnel();
    }

    return this.startUntunTunnel();
  }

  private async startLocaltunnel() {
    const localtunnelModule = (await import("localtunnel")) as {
      default?: (
        options: { port: number; host?: string },
      ) => Promise<{ url?: string; close?: () => void; on?: (...args: unknown[]) => void }>;
    };

    const createLocaltunnel = localtunnelModule.default;
    if (typeof createLocaltunnel !== "function") {
      throw new Error("localtunnel package is unavailable");
    }

    let tunnel: { url?: string; close?: () => void };
    try {
      tunnel = await createLocaltunnel({
        port: this.streamPort,
        host: "https://localtunnel.me",
      });
    } catch (error) {
      throw new Error(`Failed to start Localtunnel: ${String(error)}`);
    }

    const url = tunnel.url?.replace(/\/$/, "");
    if (!url) {
      throw new Error("Localtunnel did not return a public URL");
    }

    this.activeTunnel = {
      mode: "localtunnel",
      url,
      close: () => tunnel.close?.(),
    };

    logger.info(`Localtunnel active at ${url}`);
    return url;
  }

  private async startUntunTunnel() {
    const untunModule = (await import("untun")) as {
      startTunnel?: (options: {
        port: number;
        protocol?: "http" | "https";
        hostname?: string;
        acceptCloudflareNotice?: boolean;
      }) => Promise<unknown>;
    };

    if (typeof untunModule.startTunnel !== "function") {
      throw new Error("untun package is unavailable");
    }

    let tunnelInstance: unknown;
    try {
      tunnelInstance = await untunModule.startTunnel({
        port: this.streamPort,
        protocol: "http",
        hostname: "127.0.0.1",
        acceptCloudflareNotice: true,
      });
    } catch (error) {
      throw new Error(`Failed to start Cloudflare tunnel: ${String(error)}`);
    }

    const normalizedTunnel = tunnelInstance as Record<string, unknown>;
    const urlCandidate =
      normalizedTunnel.url ?? normalizedTunnel.tunnelUrl ?? normalizedTunnel.publicUrl;
    const closeCandidate =
      normalizedTunnel.close ?? normalizedTunnel.stop ?? normalizedTunnel.destroy;

    if (typeof urlCandidate !== "string" || !urlCandidate) {
      throw new Error("Cloudflare tunnel did not return a public URL");
    }

    if (typeof closeCandidate !== "function") {
      throw new Error("Cloudflare tunnel did not expose a close function");
    }

    const url = urlCandidate.replace(/\/$/, "");
    this.activeTunnel = {
      mode: "untun",
      url,
      close: () =>
        (closeCandidate as (...args: unknown[]) => Promise<void> | void).call(
          tunnelInstance,
        ),
    };

    logger.info(`Cloudflare tunnel active at ${url}`);
    return url;
  }

  private async closeActiveTunnel() {
    if (!this.activeTunnel) return;

    const tunnel = this.activeTunnel;
    this.activeTunnel = null;

    try {
      await Promise.resolve(tunnel.close());
      logger.info(`Closed ${tunnel.mode} tunnel (${tunnel.url})`);
    } catch (error) {
      logger.warn(`Failed to close ${tunnel.mode} tunnel`, error);
    }
  }

  private getLanAddress() {
    const interfaces = os.networkInterfaces();

    for (const values of Object.values(interfaces)) {
      if (!values) continue;
      for (const details of values) {
        if (details.family === "IPv4" && !details.internal) {
          return details.address;
        }
      }
    }

    return "127.0.0.1";
  }

  private createRoomCode() {
    return crypto.randomBytes(5).toString("hex");
  }

  private getActivePeerCount() {
    const room = this.hostedRoom;
    if (!room) return 0;

    const cutoff = Date.now() - 60_000;
    let count = 0;

    for (const timestamp of room.peerLastSeen.values()) {
      if (timestamp >= cutoff) {
        count += 1;
      }
    }

    return count;
  }

  private emitProgress(partial: Partial<RoomProgress>) {
    const payload: RoomProgress = {
      progress: partial.progress ?? 0,
      downloadSpeed: partial.downloadSpeed ?? 0,
      uploadSpeed: partial.uploadSpeed ?? 0,
      numPeers: partial.numPeers ?? 0,
      peerProgress: partial.peerProgress ?? {},
    };

    this.emit("progress", payload);
  }

  private writeJson(res: http.ServerResponse, payload: unknown) {
    const json = JSON.stringify(payload);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(json));
    res.end(json);
  }

  private readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      req.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
      });

      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8").trim();
          if (!body) {
            resolve({});
            return;
          }

          resolve(JSON.parse(body) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });

      req.on("error", reject);
    });
  }
}
