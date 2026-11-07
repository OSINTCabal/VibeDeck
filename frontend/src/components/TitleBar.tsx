import * as React from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  closeWindow, getWindowState, isFrameless, minimizeWindow,
  onWindowState, toggleMaximizeWindow, type WindowState,
} from "@/lib/windowControls";

/** `-webkit-app-region` isn't in this csstype version — extend the style type. */
type AppRegionStyle = React.CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };
const dragRegion: AppRegionStyle = { WebkitAppRegion: "drag" };
const noDragRegion: AppRegionStyle = { WebkitAppRegion: "no-drag" };

/**
 * In-app window title bar — rendered only inside the frameless desktop shell
 * (Electron). Keeps workspace actions on the left, a drag region in the
 * middle, and window controls on the right. Double-click toggles maximize.
 */
export function TitleBar() {
  const [state, setState] = React.useState<WindowState | null>(null);

  React.useEffect(() => {
    if (!isFrameless()) return;
    let off: (() => void) | undefined;
    getWindowState().then(setState);
    off = onWindowState(setState);
    return () => off?.();
  }, []);

  if (!isFrameless()) return null;

  const ctrlBtn =
    "h-10 w-11 grid place-items-center text-text-muted transition-colors " +
    "hover:text-text hover:bg-surface-muted";

  return (
    <div
      data-vd-titlebar
      className="h-10 shrink-0 flex items-center bg-sidebar border-b border-sidebar-border select-none"
      style={dragRegion}
      onDoubleClick={() => {
        // Electron handles double-click natively on win/mac; on Linux it
        // doesn't, so toggle explicitly there.
        if (window.vibedeck?.platform === "linux") toggleMaximizeWindow();
      }}
    >
      <div id="workspace-controls" className="flex items-center gap-1 pl-3" style={noDragRegion} onDoubleClick={event => event.stopPropagation()} />
      {/* drag region */}
      <div className="flex-1 h-full" />
      {/* window controls */}
      <div className="flex items-center" style={noDragRegion}>
        <button
          onClick={minimizeWindow}
          title="Minimize"
          aria-label="Minimize"
          className={ctrlBtn}
        >
          <Minus size={15} />
        </button>
        <button
          onClick={toggleMaximizeWindow}
          title={state?.maximized ? "Restore" : "Maximize"}
          aria-label={state?.maximized ? "Restore" : "Maximize"}
          className={ctrlBtn}
        >
          {state?.maximized ? <Copy size={13} /> : <Square size={13} />}
        </button>
        <button
          onClick={closeWindow}
          title="Close"
          aria-label="Close"
          className={cn(ctrlBtn, "hover:bg-danger hover:text-white")}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
