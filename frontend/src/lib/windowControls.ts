/**
 * Window controls for the frameless Electron shell.
 *
 * The shell's preload exposes `window.vibedeck`; its presence is also how the
 * frontend detects that it runs frameless (and should render its own title
 * bar). In the plain-Chrome fallback there is no bridge: the system title bar
 * stays and the in-app bar is hidden.
 */

export interface WindowState {
  maximized: boolean;
  minimized: boolean;
  fullscreen: boolean;
}

export interface DesktopSettings {
  /** Hide to the tray instead of quitting when the window is closed. */
  closeToTray: boolean;
  /** Whether a tray icon could be created on this desktop. */
  tray: boolean;
}

interface VibedeckBridge {
  platform: string;
  workspace?: {
    open: (section: string, bounds: { x: number; y: number; width: number; height: number }, theme?: "dark" | "light") => Promise<void>;
    refresh: () => Promise<void>;
    resize: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
    close: () => Promise<void>;
    connectServices: () => Promise<boolean>;
    signIn: (destination?: "work" | "admin") => Promise<boolean>;
    onState: (callback: (state: { status: string; detail: string; section?: string }) => void) => () => void;
  };
  /** Read-only Vibe Code Web queries through the signed-in workspace. */
  cloud?: {
    read: (procedure: "projects.list" | "sessions.list" | "sessions.messages",
      params?: { projectId?: string; sessionId?: string; cursor?: string }) => Promise<import("./types").CloudRaw>;
  };
  usage?: {
    account: () => Promise<{ remembered: boolean }>;
    connect: () => Promise<boolean>;
    confirmSignIn: (accepted: boolean) => Promise<boolean>;
    disconnect: () => Promise<boolean>;
    read: (year: number, month: number, refresh?: boolean) => Promise<import("./types").UsageSnapshot>;
  };
  desktop?: {
    get: () => Promise<DesktopSettings>;
    set: (patch: Partial<Pick<DesktopSettings, "closeToTray">>) => Promise<DesktopSettings>;
  };
  tray?: {
    setUsage: (value: { label: string; percent: number } | null) => Promise<void>;
  };
  getZoom: () => Promise<number>;
  setZoom: (factor: number) => Promise<number>;
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  getState: () => Promise<WindowState>;
  onState: (cb: (s: WindowState) => void) => () => void;
  pickDirectory: () => Promise<string | null>;
}

declare global {
  interface Window {
    vibedeck?: VibedeckBridge;
  }
}

/** True when running inside the frameless desktop shell. */
export function isFrameless(): boolean {
  return typeof window !== "undefined" && !!window.vibedeck;
}

export function minimizeWindow(): void {
  window.vibedeck?.minimize().catch(() => {});
}

export function toggleMaximizeWindow(): void {
  window.vibedeck?.toggleMaximize().catch(() => {});
}

export function closeWindow(): void {
  window.vibedeck?.close().catch(() => {});
}

export function getWindowState(): Promise<WindowState | null> {
  return window.vibedeck ? window.vibedeck.getState().catch(() => null) : Promise.resolve(null);
}

export function onWindowState(cb: (s: WindowState) => void): (() => void) | undefined {
  return window.vibedeck?.onState(cb);
}

/** Native "choose a directory" dialog (Electron shell only). Null when the
 *  bridge is absent (browser fallback) or the user cancels. */
export function pickDirectory(): Promise<string | null> {
  return window.vibedeck ? window.vibedeck.pickDirectory().catch(() => null) : Promise.resolve(null);
}
