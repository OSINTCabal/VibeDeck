// Preload bridge: exposes a minimal, safe `window.vibedeck` API to the SPA.
// The frontend uses its presence to detect the frameless Electron shell and to
// drive window controls (minimize / maximize / close / state).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibedeck", {
  platform: process.platform,
  workspace: {
    open: (section, bounds, theme) => ipcRenderer.invoke("workspace:open", section, bounds, theme),
    refresh: () => ipcRenderer.invoke("workspace:refresh"),
    resize: bounds => ipcRenderer.invoke("workspace:resize", bounds),
    close: () => ipcRenderer.invoke("workspace:close"),
    connectServices: () => ipcRenderer.invoke("workspace:connectors"),
    signIn: destination => ipcRenderer.invoke("workspace:signin", destination),
    onState: callback => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("workspace:state", listener);
      return () => ipcRenderer.removeListener("workspace:state", listener);
    },
  },
  usage: {
    account: () => ipcRenderer.invoke("usage:account"),
    connect: () => ipcRenderer.invoke("usage:connect"),
    confirmSignIn: accepted => ipcRenderer.invoke("usage:confirm-signin", accepted),
    disconnect: () => ipcRenderer.invoke("usage:disconnect"),
    read: (year, month, refresh = false) => ipcRenderer.invoke("usage:read", year, month, refresh),
  },
  getZoom: () => ipcRenderer.invoke("window:get-zoom"),
  setZoom: factor => ipcRenderer.invoke("window:set-zoom", factor),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  getState: () => ipcRenderer.invoke("window:state"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
  // Native directory picker (project selection). Null when cancelled or
  // unavailable; the SPA falls back to a manual path input.
  pickDirectory: () => ipcRenderer.invoke("vibedeck:pick-directory"),
});

// A completed web sign-in must refresh after the main process invalidates its cache.
ipcRenderer.on("usage:changed", () => window.dispatchEvent(new Event("vibedeck:usage-refresh")));
