// Tray icon and "keep running when closed" mode. Preferences live next to the
// zoom setting in userData; the tray stays visible either way so the window can
// always be brought back.
const { app, Menu, Tray, nativeImage } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULTS = { closeToTray: false };
const file = () => path.join(app.getPath("userData"), "desktop.json");

function createDesktop({ getWindow, showWindow, navigate, onChange }) {
  let settings = { ...DEFAULTS };
  let tray = null;
  let usage = null;

  async function load() {
    try {
      const saved = JSON.parse(await fs.readFile(file(), "utf8"));
      if (typeof saved.closeToTray === "boolean") settings.closeToTray = saved.closeToTray;
    } catch { /* Missing or invalid preferences use the defaults. */ }
    return settings;
  }

  async function update(patch) {
    if (!patch || typeof patch !== "object") throw new Error("Invalid desktop settings");
    const next = { ...settings };
    if ("closeToTray" in patch) {
      if (typeof patch.closeToTray !== "boolean") throw new Error("Invalid desktop settings");
      next.closeToTray = patch.closeToTray;
    }
    await fs.writeFile(file(), JSON.stringify(next), { mode: 0o600 });
    settings = next;
    refresh();
    onChange?.(settings);
    return settings;
  }

  function toggleWindow() {
    const win = getWindow();
    if (win && win.isVisible() && win.isFocused()) win.hide();
    else showWindow();
  }

  function refresh() {
    if (!tray) return;
    const status = usage ? `${usage.label}: ${Math.round(usage.percent)}% used` : null;
    tray.setToolTip(status ? `VibeDeck — ${status}` : "VibeDeck");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show VibeDeck", click: () => showWindow() },
      ...(status ? [{ label: status, enabled: false }] : []),
      { type: "separator" },
      { label: "New session", click: () => navigate("/") },
      { label: "Usage", click: () => navigate("/usage") },
      { label: "Settings", click: () => navigate("/settings?section=config") },
      { type: "separator" },
      { label: "Keep running when closed", type: "checkbox", checked: settings.closeToTray,
        click: item => { void update({ closeToTray: item.checked }).catch(() => refresh()); } },
      { type: "separator" },
      { label: "Quit VibeDeck", click: () => app.quit() },
    ]));
  }

  function start() {
    if (tray) return;
    try {
      // The bare mark reads better than the app tile at tray size.
      const icon = nativeImage.createFromPath(path.join(__dirname, "vibedeck-tray.png"));
      tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: process.platform === "darwin" ? 16 : 22, quality: "best" }));
    } catch {
      tray = null; // No system tray available; closing then behaves normally.
      return;
    }
    tray.on("click", toggleWindow);
    refresh();
  }

  function setUsage(value) {
    if (value === null) usage = null;
    else if (value && typeof value.label === "string" && value.label.length <= 60
      && typeof value.percent === "number" && Number.isFinite(value.percent)) {
      usage = { label: value.label, percent: Math.max(0, Math.min(100, value.percent)) };
    } else throw new Error("Invalid usage status");
    refresh();
  }

  return {
    load, update, start, setUsage,
    get: () => ({ ...settings, tray: !!tray }),
    // Hide instead of closing only when a tray icon exists to restore from.
    keepRunning: () => settings.closeToTray && !!tray,
    destroy: () => { tray?.destroy(); tray = null; },
  };
}

module.exports = { createDesktop };
