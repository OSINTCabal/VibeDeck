import * as React from "react";
import { Check, ChevronDown, GitBranch, Loader2, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { getGitBranches, switchGitBranch, type GitBranches } from "@/lib/api";

/**
 * Branch chip shown next to the project chip when the working directory is a
 * git repository: lists local branches, switches, or creates a new one. Git
 * itself refuses a switch that would overwrite uncommitted changes.
 */
export function BranchPicker({ cwd, className }: { cwd: string; className?: string }) {
  const [info, setInfo] = React.useState<GitBranches | null>(null);
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    if (!cwd) { setInfo(null); return; }
    getGitBranches(cwd).then(setInfo).catch(() => setInfo(null));
  }, [cwd]);

  React.useEffect(() => { setInfo(null); setError(null); load(); }, [load]);
  React.useEffect(() => { if (open) load(); }, [open, load]);
  React.useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!info) return null;

  const needle = q.trim();
  const filtered = info.branches.filter((b) => !needle || b.toLowerCase().includes(needle.toLowerCase()));
  const canCreate = !!needle && !info.branches.includes(needle);

  const choose = async (branch: string, create = false) => {
    if (busy || (!create && branch === info.current)) { setOpen(false); return; }
    setBusy(true);
    setError(null);
    try {
      setInfo(await switchGitBranch(info.root, branch, create));
      setOpen(false);
      setQ("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setQ(""); setError(null); }}
        title={`Branch ${info.current || "(detached)"}${info.dirty ? " · uncommitted changes" : ""}`}
        aria-label="Select git branch"
        className="flex items-center gap-1.5 h-8 max-w-[160px] rounded-md px-2.5 text-sm text-text-muted hover:bg-surface-muted hover:text-text transition-colors duration-75 ease-out"
      >
        <GitBranch size={16} className="shrink-0" />
        <span className="hidden truncate sm:inline">{info.current || "detached"}</span>
        {info.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="Uncommitted changes" />}
        <ChevronDown size={14} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div data-side="top" className="absolute left-0 bottom-full mb-2 z-50 w-72 max-w-[calc(100vw-2rem)] vd-menu rounded-xl border border-border bg-surface-raised shadow-lg overflow-hidden">
            <div className="flex items-center gap-2 px-3 border-b border-border">
              <Search size={13} className="text-text-faint shrink-0" />
              <input
                autoFocus
                value={q}
                onChange={(e) => { setQ(e.target.value); setError(null); }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (filtered.includes(needle)) void choose(needle);
                  else if (canCreate) void choose(needle, true);
                  else if (filtered[0]) void choose(filtered[0]);
                }}
                placeholder="Switch or create branch…"
                aria-label="Search branches"
                className="w-full bg-transparent py-2.5 text-sm text-text placeholder:text-text-faint focus:outline-none"
              />
              {busy && <Loader2 size={13} className="shrink-0 animate-spin text-text-faint" />}
            </div>
            {info.dirty && (
              <p className="px-3 pt-2 text-[11px] text-text-faint">Uncommitted changes. Git only switches when they don’t conflict.</p>
            )}
            {error && <p role="alert" className="px-3 pt-2 text-[11px] text-danger">{error}</p>}
            <div className="max-h-64 overflow-y-auto py-1">
              {filtered.map((b) => (
                <button
                  key={b}
                  type="button"
                  disabled={busy}
                  onClick={() => void choose(b)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:opacity-60",
                    b === info.current ? "bg-surface-muted" : "hover:bg-surface-muted/60",
                  )}
                >
                  <Check size={13} className={cn("shrink-0", b === info.current ? "text-primary" : "opacity-0")} />
                  <span className="truncate font-mono text-xs text-text">{b}</span>
                </button>
              ))}
              {canCreate && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void choose(needle, true)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-text-muted hover:bg-surface-muted/60 transition-colors disabled:opacity-60"
                >
                  <Plus size={13} className="shrink-0" />
                  <span className="truncate">Create branch <span className="font-mono text-text">{needle}</span></span>
                </button>
              )}
              {!filtered.length && !canCreate && (
                <div className="px-3 py-3 text-xs text-text-faint">No branches.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
