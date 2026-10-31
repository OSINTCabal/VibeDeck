import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { menuItem, menuPanel, usePresence } from "./ui";

export interface SessionMenuItem {
  label: string;
  icon: React.ElementType;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

/**
 * A small actions menu (the webapp's ⋮ / ⌄ session menu). Rendered in a
 * portal with fixed positioning so scroll containers never clip it; opens
 * below the trigger, or above when there is no room.
 */
export function SessionMenu({
  items, label, trigger, triggerClassName, align = "end",
}: {
  items: SessionMenuItem[];
  label: string;
  trigger: React.ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = React.useState(false);
  const presence = usePresence(open);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; left?: number; right?: number; side: "top" | "bottom" }>({ side: "bottom" });

  React.useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const horizontal = align === "end" ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, r.left) };
    setPos(below >= items.length * 40 + 24 || below >= r.top
      ? { top: r.bottom + 4, ...horizontal, side: "bottom" }
      : { bottom: window.innerHeight - r.top + 4, ...horizontal, side: "top" });
  }, [open, align, items.length]);

  React.useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !btnRef.current?.contains(target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); btnRef.current?.focus(); } };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const stop = (event: React.SyntheticEvent) => { event.preventDefault(); event.stopPropagation(); };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={event => { stop(event); setOpen(o => !o); }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {presence.mounted && createPortal(
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          data-side={pos.side}
          data-state={presence.state}
          style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, right: pos.right }}
          className={cn(menuPanel, "z-50 flex w-56 flex-col gap-1")}
        >
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              onClick={event => { stop(event); setOpen(false); item.onSelect(); }}
              className={cn(menuItem, "disabled:pointer-events-none disabled:opacity-50", item.danger && "text-danger")}
            >
              <item.icon size={16} className="shrink-0" />
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
