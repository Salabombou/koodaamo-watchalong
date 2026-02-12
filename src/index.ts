import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import logger from "./utilities/logging";

import { StorageService } from "./services/StorageService";
import { MediaService } from "./services/MediaService";
import { TorrentService } from "./services/TorrentService";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "stream",
    privileges: {
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

logger.log("Running app version ", app.getVersion());

// Initialize Services
let storageService: StorageService;
logger.info("Initializing services...");
const mediaService = new MediaService();
const torrentService = new TorrentService();
logger.info("Services initialized.");

// Enable auto-updates
updateElectronApp({
  updateSource: {
    type: UpdateSourceType.StaticStorage,
    baseUrl: `https://github.com/Salabombou/koodaamo-watchalong/releases/download/${app.getVersion()}/koodaamo-watchalong-${app.getVersion()}.Setup.exe`
  },
  logger: {
    info: (msg) => logger.info(msg),
    warn: (msg) => logger.warn(msg),
    error: (msg) => logger.error(msg),
    log: (msg) => logger.info(msg),
  },
});

// Global Error Handlers
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  if (error instanceof Error) {
    logger.error("Stack Trace:", error.stack);
  }
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Rejection:", reason);
  if (reason instanceof Error) {
    logger.error("Stack Trace:", reason.stack);
  }
});

ipcMain.handle("get-node-version", () => {
  logger.info("Renderer asked for node version");
  return process.version;
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require("electron-squirrel-startup")) {
  app.quit();
}

const createWindow = () => {
  logger.info("Creating main window...");
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the main app
  logger.info(`Loading URL: ${MAIN_WINDOW_WEBPACK_ENTRY}`);
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Wait for the main window to be ready
  mainWindow.once("ready-to-show", () => {
    logger.info("Main window ready to show");
    mainWindow.show();
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription) => {
      logger.error(`Failed to load window: ${errorCode} - ${errorDescription}`);
    },
  );
};

let playerWindow: BrowserWindow | null = null;

const createPlayerWindow = () => {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.show();
    playerWindow.focus();
    return;
  }

  playerWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    autoHideMenuBar: true,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  playerWindow.on("closed", () => {
    playerWindow = null;
  });

  playerWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY + "#/player");
};

app.on("ready", () => {
  logger.info("App Ready event fired.");
  protocol.handle("stream", (req) => {
    return torrentService.handleStreamRequest(req);
  });

  storageService = new StorageService(app.getPath("userData"));
  storageService.init().then(() => storageService.cleanup());

  createWindow();

  // Check for updates
  try {
    logger.info("Checking for updates...");
  } catch (err) {
    logger.error("Error checking for updates:", err);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// --- IPC Handlers ---

// Window Management
ipcMain.handle("window:resize", (event, width, height) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    window.setContentSize(Math.round(width), Math.round(height), true);
  }
});

ipcMain.handle("window:set-aspect-ratio", (event, ratio) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  window?.setAspectRatio(ratio);
});

ipcMain.handle("window:set-always-on-top", (event, enabled) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  window?.setAlwaysOnTop(enabled, "screen-saver");
});

// Storage
ipcMain.handle("storage:import", async (_, filePath) => {
  return storageService.importFile(filePath);
});

// Media
ipcMain.handle("media:analyze", async (_, filePath) => {
  return mediaService.analyze(filePath);
});

ipcMain.handle("media:normalize", async (event, filePath) => {
  const outputDir = storageService.getStoragePath();
  try {
    const result = await mediaService.normalize(filePath, outputDir, (p) => {
      event.sender.send("media:progress", p);
    });
    return result;
  } catch (e: unknown) {
    if (e instanceof Error) {
      throw new Error(e.message);
    }
    throw new Error(String(e));
  }
});

// Torrent
ipcMain.handle("torrent:seed", (_, filePath, trackers) => {
  return torrentService.seed(filePath, trackers);
});

ipcMain.handle("torrent:add", (_, magnet) => {
  return torrentService.add(magnet);
});

ipcMain.handle("torrent:is-host", () => {
  return torrentService.isHost;
});

ipcMain.handle("torrent:get-stream", () => {
  return torrentService.getStreamUrl();
});

ipcMain.on("torrent:broadcast", (_, cmd) => {
  torrentService.broadcast(cmd);
});

ipcMain.handle("open-player-window", () => {
  createPlayerWindow();
});

// Events
torrentService.on("progress", (data) => {
  BrowserWindow.getAllWindows().forEach((w) =>
    w.webContents.send("torrent:progress", data),
  );
});
torrentService.on("done", () => {
  BrowserWindow.getAllWindows().forEach((w) =>
    w.webContents.send("torrent:done"),
  );
});

torrentService.on("sync-command", (cmd) => {
  BrowserWindow.getAllWindows().forEach((w) =>
    w.webContents.send("sync:command", cmd),
  );
});

torrentService.on("error", (err) => {
  BrowserWindow.getAllWindows().forEach((w) =>
    w.webContents.send("torrent:error", err.message || err),
  );
});
