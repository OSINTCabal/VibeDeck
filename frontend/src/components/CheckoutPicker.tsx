import * as React from "react";
import { Check, ChevronDown, Folder, FolderTree } from "lucide-react";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { worktree: false, label: "Current checkout", hint: "Work in the project folder as it is", icon: Folder },
  { worktree: true, label: "New worktree", hint: "A separate checkout on its own branch, so this one stays untouched", icon: FolderTree },
];

/** Where a new Code session works: the project's own checkout or a new git worktree. */
export function CheckoutPicker({ worktree, onChange }: { worktree: boolean; onChange: (worktree: boolean) => void }) {
  const [open, setOpen] = React.useState(false);
  const current = OPTIONS.find(o => o.worktree === worktree) || OPTIONS[0];
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        aria-label={`Checkout: ${current.label}`}
        className={cn("flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors duration-75 ease-out hover:bg-surface-muted",
          worktree ? "text-primary" : "text-text-muted hover:text-text")}>
        <current.icon size={13} className="shrink-0" />
        <span>{current.label}</span>
        <ChevronDown size={12} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="listbox" data-side="top"
            className="vd-menu absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-surface-raised py-1 shadow-lg">
            {OPTIONS.map(o => (
              <button key={o.label} type="button" role="option" aria-selected={o.worktree === worktree}
                onClick={() => { onChange(o.worktree); setOpen(false); }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-muted/60">
                <o.icon size={14} className="mt-0.5 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-text">{o.label}</span>
                  <span className="block text-[11px] text-text-faint">{o.hint}</span>
                </span>
                <Check size={13} className={cn("mt-1 shrink-0", o.worktree === worktree ? "text-primary" : "opacity-0")} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
