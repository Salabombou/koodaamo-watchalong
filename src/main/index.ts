import { app, BrowserWindow, protocol } from "electron";
import logger from "@utilities/logging";
import path from "path";
import { IPC_CHANNELS } from "@shared/channels";

import { StorageService } from "@services/StorageService";
import { MediaService } from "@services/MediaService";
import { RoomService } from "@services/RoomService";

import { AppController } from "@controllers/AppController";
import { WindowController } from "@controllers/WindowController";
import { MediaController } from "@controllers/MediaController";
import { RoomController } from "@controllers/RoomController";

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

logger.info("Running app version " + app.getVersion());

// Initialize Services
let storageService: StorageService;
logger.info("Initializing services...");
const mediaService = new MediaService();
const roomService = new RoomService();
logger.info("Services initialized.");

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

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require("electron-squirrel-startup")) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let pendingInvite: string | null = null;

const extractInviteFromArgs = (args: string[]) =>
  args.find((arg) => arg.startsWith("koodaamo-watchalong://")) ?? null;

const dispatchInvite = (inviteUrl: string) => {
  pendingInvite = inviteUrl;

  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.APP.INVITE_OPENED, inviteUrl);
};

pendingInvite = extractInviteFromArgs(process.argv);

const createWindow = () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }

  logger.info("Creating main window...");
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      nodeIntegration: false,
      webSecurity: true,
      contextIsolation: true,
    },
  });

  // Load the main app
  logger.info(`Loading URL: ${MAIN_WINDOW_WEBPACK_ENTRY}`);
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Wait for the main window to be ready
  mainWindow.once("ready-to-show", () => {
    logger.info("Main window ready to show");
    if (mainWindow) mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    app.exit(0);
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (event, errorCode, errorDescription) => {
      logger.error(`Failed to load window: ${errorCode} - ${errorDescription}`);
    },
  );

  mainWindow.webContents.once("did-finish-load", () => {
    if (pendingInvite && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.APP.INVITE_OPENED, pendingInvite);
      pendingInvite = null;
    }
  });
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
      webSecurity: true,
      contextIsolation: true,
    },
  });

  playerWindow.on("closed", () => {
    playerWindow = null;
  });

  playerWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY + "#/player");
};

// Only run app logic when ready
app.whenReady().then(() => {
  logger.info("App Ready event fired.");

  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("koodaamo-watchalong", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient("koodaamo-watchalong");
  }

  // Register protocol
  protocol.handle("stream", () => {
    return new Response("Stream protocol is disabled", { status: 410 });
  });

  storageService = new StorageService(app.getPath("userData"));
  storageService.init().then(() => storageService.cleanup());

  // Initialize Controllers
  new AppController(); // Handles updates internally now
  new WindowController(createPlayerWindow);
  new MediaController(mediaService, storageService);
  new RoomController(roomService);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      void roomService.shutdown();
      app.quit();
    }
  });

  app.on("before-quit", () => {
    void roomService.shutdown();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (url.startsWith("koodaamo-watchalong://")) {
      dispatchInvite(url);
      createWindow();
    }
  });
});
