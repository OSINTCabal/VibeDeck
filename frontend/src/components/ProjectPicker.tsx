import * as React from "react";
import { Check, ChevronDown, FolderOpen, FolderSearch, Keyboard, Home } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjects } from "@/lib/api";
import { pickDirectory } from "@/lib/windowControls";

interface ProjectDir {
  path: string;
  name: string;
  lastUsed?: number;
}

const RECENTS_KEY = "vibedeck.cwd.recents";
const MAX_RECENTS = 8;

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeRecents(list: string[]) {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch { /* storage full/blocked — recents are best-effort */ }
}

export function rememberCwd(path: string) {
  if (!path) return;
  const list = readRecents().filter((p) => p !== path);
  list.unshift(path);
  writeRecents(list);
}

function baseName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/**
 * The composer's project chip: shows the working directory and opens a menu
 * with recent projects, known project directories, a native directory browser
 * (Electron shell), and a manual path input (always available).
 */
export function ProjectPicker({
  cwd, onChange, className,
}: {
  cwd: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(cwd);
  const [recent, setRecent] = React.useState<ProjectDir[]>([]);
  const [known, setKnown] = React.useState<ProjectDir[]>([]);
  const [home, setHome] = React.useState("");
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = React.useState<"up" | "down">("up");
  const [listMaxH, setListMaxH] = React.useState(320);

  // load candidates once per mount
  React.useEffect(() => {
    getProjects().then((d) => {
      setHome(d.home || "");
      setRecent(d.recent || []);
      setKnown(d.known || []);
    }).catch(() => {});
  }, []);

  // menu placement: open upward (composer sits at the bottom), flip if needed
  React.useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const spaceAbove = r.top - 8;
    const spaceBelow = window.innerHeight - r.bottom - 8;
    if (spaceAbove >= 320 || spaceAbove >= spaceBelow) {
      setPlacement("up");
      setListMaxH(Math.max(160, Math.min(320, spaceAbove - 8)));
    } else {
      setPlacement("down");
      setListMaxH(Math.max(160, Math.min(320, spaceBelow - 8)));
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const select = (path: string) => {
    onChange(path);
    rememberCwd(path);
    setOpen(false);
    setEditing(false);
  };

  const browse = async () => {
    const picked = await pickDirectory();
    if (picked) select(picked);
    // cancelled or no bridge — keep the menu open so the user can pick manually
  };

  // merge localStorage recents with the sidecar's session-derived recents
  const localRecents = readRecents();
  const mergedRecent: ProjectDir[] = [];
  const seen = new Set<string>();
  for (const p of [...localRecents, ...recent.map((r) => r.path)]) {
    if (seen.has(p)) continue;
    seen.add(p);
    mergedRecent.push({ path: p, name: baseName(p) });
  }
  const knownFiltered = known.filter((k) => !seen.has(k.path));

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { onChange(draft.trim()); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { onChange(draft.trim()); setEditing(false); }
          if (e.key === "Escape") { setDraft(cwd); setEditing(false); }
        }}
        placeholder="Working directory"
        title="Working directory (defaults to your home)"
        className="h-7 w-48 rounded-md bg-surface-muted px-2 font-mono text-xs text-text placeholder:text-text-faint focus:outline-none"
      />
    );
  }

  const row = (p: ProjectDir, icon: React.ReactNode) => {
    const active = p.path === cwd;
    return (
      <button
        key={p.path}
        type="button"
        onClick={() => select(p.path)}
        title={p.path}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
          active ? "bg-surface-muted" : "hover:bg-surface-muted/60",
        )}
      >
        <Check size={13} className={cn("shrink-0", active ? "text-primary" : "opacity-0")} />
        <span className="shrink-0 text-text-faint">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-text truncate">{p.name}</span>
          <span className="block text-[10px] text-text-faint font-mono truncate">{p.path}</span>
        </span>
      </button>
    );
  };

  const section = (label: string) => (
    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-text-faint">{label}</div>
  );

  return (
    <div className={cn("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={cwd || "Select project"}
        aria-label="Select project directory"
        className="flex items-center gap-1 h-7 max-w-[180px] rounded-lg px-2 text-[13px] text-text-muted hover:bg-surface-muted hover:text-text transition-colors"
      >
        <FolderOpen size={12} className="shrink-0" />
        <span className="truncate font-mono text-xs">{cwd ? baseName(cwd) : "Select project"}</span>
        <ChevronDown size={11} className="shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={cn(
            "absolute left-0 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface-raised shadow-2xl overflow-hidden animate-slide-up",
            placement === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}>
            <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-text-faint border-b border-border">
              Project directory
            </div>
            <div className="overflow-y-auto py-1" style={{ maxHeight: listMaxH }}>
              {mergedRecent.length > 0 && (
                <>
                  {section("Recent")}
                  {mergedRecent.slice(0, MAX_RECENTS).map((p) => row(p, <FolderOpen size={13} />))}
                </>
              )}
              {knownFiltered.length > 0 && (
                <>
                  {section("Projects")}
                  {knownFiltered.map((p) => row(p, <FolderOpen size={13} />))}
                </>
              )}
              {home && !seen.has(home) && (
                <>
                  {section("Locations")}
                  {row({ path: home, name: "Home" }, <Home size={13} />)}
                </>
              )}
              <div className="border-t border-border mt-1 pt-1">
                <button
                  type="button"
                  onClick={browse}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-text-muted hover:bg-surface-muted/60 transition-colors"
                >
                  <FolderSearch size={13} className="shrink-0" /> Browse for directory…
                </button>
                <button
                  type="button"
                  onClick={() => { setDraft(cwd); setEditing(true); setOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-text-muted hover:bg-surface-muted/60 transition-colors"
                >
                  <Keyboard size={13} className="shrink-0" /> Enter path manually…
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
