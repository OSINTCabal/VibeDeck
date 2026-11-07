// VibeDeck Electron shell — a frameless desktop window hosting the VibeDeck SPA.
//
// The window has no system title bar (frame: false); the frontend renders its
// own in-app title bar (TitleBar.tsx) and drives window controls through the
// `window.vibedeck` bridge exposed by preload.js.
//
// Launch:  electron /path/to/shell/electron            (loads VIBEDECK_URL or
//          http://127.0.0.1:9377 by default)

const { app, BrowserWindow, ipcMain, screen, dialog, session, shell } = require("electron");
const path = require("path");
const fs = require("node:fs/promises");
if (process.platform === "linux") app.setDesktopName("vibedeck.desktop");
const ZOOM_FACTORS = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
let zoomFactor = 1;

const PORT = process.env.VIBEDECK_PORT || "9377";
const URL = process.env.VIBEDECK_URL || `http://127.0.0.1:${PORT}`;

let win = null;
const usage = require("./usage");
const workspace = require("./workspace").createWorkspace(() => win);
const APP_ORIGIN = new global.URL(URL).origin;
function trustedSender(event) {
  return event.sender === win?.webContents && event.senderFrame?.origin === APP_ORIGIN;
}
function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trustedSender(event)) throw new Error("Untrusted desktop request");
    return handler(...args);
  });
}

// The app loads from the local sidecar, which serves the freshly built SPA.
// Never let Chromium pin a stale bundle: clear the HTTP cache on every launch
// and force revalidation of every request, so a rebuilt frontend (new hashed
// assets) is picked up immediately. Without this, a launch while the sidecar
// is briefly unreachable can serve an ancient cached index.html and the app
// boots into an old, broken UI.
async function prepareSession() {
  try {
    await session.defaultSession.clearCache();
  } catch { /* cache clearing is best-effort */ }
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders["Cache-Control"] = "no-cache";
    details.requestHeaders["Pragma"] = "no-cache";
    callback({ requestHeaders: details.requestHeaders });
  });
}

function windowState() {
  if (!win || win.isDestroyed()) {
    return { maximized: false, minimized: false, fullscreen: false };
  }
  return {
    maximized: win.isMaximized(),
    minimized: win.isMinimized(),
    fullscreen: win.isFullScreen(),
  };
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1440, workArea.width),
    height: Math.min(900, workArea.height),
    minWidth: 960,
    minHeight: 600,
    frame: false, // true frameless — the SPA draws its own title bar
    backgroundColor: "#0a0a0a",
    title: "Vibe",
    icon: path.join(__dirname, "vibedeck-icon.png"), // dark app icon (taskbar/dock)
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.on("did-finish-load", () => win?.webContents.setZoomFactor(zoomFactor));
  win.once("ready-to-show", () => win.show());

  // The launcher starts the sidecar first, but retry briefly so a slow boot
  // doesn't leave the user staring at an error page.
  let tries = 0;
  win.webContents.on("did-fail-load", (_e, errorCode) => {
    if (errorCode === -3) return; // aborted (superseded navigation) — not a failure
    if (tries++ < 60) setTimeout(() => win && !win.isDestroyed() && win.loadURL(URL), 500);
  });
  win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) workspace.close();
  });
  win.webContents.on("will-navigate", (event, target) => {
    try { if (new global.URL(target).origin !== APP_ORIGIN) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new global.URL(url).protocol === "https:") void shell.openExternal(url); } catch { /* Invalid link. */ }
    return { action: "deny" };
  });
  win.loadURL(URL);

  const pushState = () => {
    if (win && !win.isDestroyed()) win.webContents.send("window:state", windowState());
  };
  for (const ev of ["maximize", "unmaximize", "minimize", "restore",
                    "enter-full-screen", "leave-full-screen"]) {
    win.on(ev, pushState);
  }

  win.on("closed", () => { workspace.close(); win = null; });
}

handle("window:minimize", () => { if (win) win.minimize(); });
handle("window:toggle-maximize", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
handle("window:close", () => { if (win) win.close(); });
handle("window:state", () => windowState());

// Native "choose a project directory" dialog for the composer's project chip.
// Returns the selected path, or null when the user cancels.
handle("vibedeck:pick-directory", async () => {
  if (!win || win.isDestroyed()) return null;
  const result = await dialog.showOpenDialog(win, {
    title: "Select project directory",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

async function connectAccount(destination = "work") {
  try {
    const connected = await usage.connect(win, destination);
    if (connected) await workspace.reset();
    return connected;
  } finally {
    if (win && !win.isDestroyed()) win.focus();
  }
}
handle("usage:account", () => usage.account());
handle("usage:connect", () => connectAccount());
handle("usage:confirm-signin", accepted => usage.confirmSignIn(accepted === true));
handle("usage:disconnect", async () => {
  const results = await Promise.allSettled([workspace.reset(), usage.disconnect()]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results[1].value;
});
handle("usage:read", (year, month, refresh) => usage.read(year, month, refresh === true));

handle("workspace:open", (section, bounds, theme) => workspace.open(section, bounds, theme));
handle("workspace:refresh", () => workspace.refresh());
handle("workspace:resize", bounds => workspace.resize(bounds));
handle("workspace:close", () => workspace.close());
handle("workspace:signin", (destination = "work") => connectAccount(destination));
handle("workspace:connectors", () => connectAccount("connectors"));

handle("window:get-zoom", () => zoomFactor);
handle("window:set-zoom", async factor => {
  if (!ZOOM_FACTORS.includes(factor)) throw new Error("Invalid zoom factor");
  await fs.writeFile(path.join(app.getPath("userData"), "display.json"), JSON.stringify({zoomFactor:factor}), {mode:0o600});
  zoomFactor = factor;
  win?.webContents.setZoomFactor(factor);
  workspace.setZoom(factor);
  return factor;
});
app.whenReady().then(async () => {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(app.getPath("userData"), "display.json"), "utf8"));
    if (ZOOM_FACTORS.includes(saved.zoomFactor)) zoomFactor = saved.zoomFactor;
  } catch { /* Missing or invalid display preferences use 100%. */ }
  await prepareSession();
  createWindow();
});

app.on("window-all-closed", () => app.quit());
let stopping = false;
app.on("before-quit", event => {
  if (stopping) return;
  event.preventDefault();
  stopping = true;
  workspace.close();
  usage.shutdown().catch(() => {}).finally(() => app.quit());
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
