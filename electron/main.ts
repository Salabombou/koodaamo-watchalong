import { app, BrowserWindow, ipcMain, protocol } from "electron";
import path from "path";
import squirrelStartup from "electron-squirrel-startup";
import { StorageService } from "./services/StorageService";
import { MediaService } from "./services/MediaService";
import { TorrentService } from "./services/TorrentService";

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

// Initialize Services
let storageService: StorageService;
const mediaService = new MediaService();
const torrentService = new TorrentService();

ipcMain.handle("get-node-version", () => {
  console.log("Renderer asked for node version");
  return process.version;
});

// const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (squirrelStartup) {
  app.quit();
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the main app
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Wait for the main window to be ready
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
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
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  playerWindow.on("closed", () => {
    playerWindow = null;
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    playerWindow.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#/player`);
  } else {
    const indexPath = path.join(
      __dirname,
      `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
    );
    playerWindow.loadURL(`file://${indexPath}#/player`);
  }
};

app.on("ready", () => {
  protocol.handle("stream", (req) => {
    return torrentService.handleStreamRequest(req);
  });

  storageService = new StorageService(app.getPath("userData"));
  storageService.init().then(() => storageService.cleanup());

  createWindow();
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
