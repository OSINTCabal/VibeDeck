import * as React from "react";
import { Check, ChevronDown, FolderGit2, FolderOpen, FolderSearch, GitBranch, Keyboard, Home, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjects } from "@/lib/api";
import { pickDirectory } from "@/lib/windowControls";

interface ProjectDir {
  path: string;
  name: string;
  lastUsed?: number;
  branch?: string | null;
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
  const [repos, setRepos] = React.useState<ProjectDir[]>([]);
  const [home, setHome] = React.useState("");
  const [q, setQ] = React.useState("");
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = React.useState<"up" | "down">("up");
  const [listMaxH, setListMaxH] = React.useState(320);

  // load candidates on mount and whenever the menu opens (branches change)
  React.useEffect(() => {
    if (!open && recent.length + known.length + repos.length > 0) return;
    getProjects().then((d) => {
      setHome(d.home || "");
      setRecent(d.recent || []);
      setKnown(d.known || []);
      setRepos(d.repos || []);
    }).catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // menu placement: open upward (composer sits at the bottom), flip if needed
  React.useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const spaceAbove = r.top - 8;
    const spaceBelow = window.innerHeight - r.bottom - 8;
    if (spaceAbove >= 320 || spaceAbove >= spaceBelow) {
      setPlacement("up");
      setListMaxH(Math.max(160, Math.min(320, spaceAbove - 50)));
    } else {
      setPlacement("down");
      setListMaxH(Math.max(160, Math.min(320, spaceBelow - 50)));
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
    setQ("");
  };

  const browse = async () => {
    const picked = await pickDirectory();
    if (picked) select(picked);
    // cancelled or no bridge — keep the menu open so the user can pick manually
  };

  // merge localStorage recents with the sidecar's session-derived recents
  const branchOf = new Map<string, string | null | undefined>([
    ...repos.map((r) => [r.path, r.branch] as const),
    ...recent.map((r) => [r.path, r.branch] as const),
  ]);
  const localRecents = readRecents();
  const mergedRecent: ProjectDir[] = [];
  const seen = new Set<string>();
  for (const p of [...localRecents, ...recent.map((r) => r.path)]) {
    if (seen.has(p)) continue;
    seen.add(p);
    mergedRecent.push({ path: p, name: baseName(p), branch: branchOf.get(p) });
  }
  const needle = q.trim().toLowerCase();
  const matches = (p: ProjectDir) => !needle || p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle);
  const recentShown = mergedRecent.slice(0, needle ? undefined : MAX_RECENTS).filter(matches);
  const reposShown = repos.filter((r) => !seen.has(r.path) && matches(r));
  const knownFiltered = known.filter((k) => !seen.has(k.path) && matches(k));

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
          <span className="flex items-center gap-1.5">
            <span className="text-xs text-text truncate">{p.name}</span>
            {p.branch && (
              <span className="flex shrink-0 items-center gap-0.5 rounded bg-surface-muted px-1 py-px font-mono text-[10px] text-text-muted max-w-[110px]" title={`Branch ${p.branch}`}>
                <GitBranch size={9} className="shrink-0" /><span className="truncate">{p.branch}</span>
              </span>
            )}
          </span>
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
        onClick={() => { setOpen((o) => !o); setQ(""); }}
        title={cwd || "Select project"}
        aria-label="Select project directory"
        className="flex items-center gap-1.5 h-8 max-w-[180px] rounded-md px-2.5 text-sm text-text-muted hover:bg-surface-muted hover:text-text transition-colors duration-75 ease-out"
      >
        <FolderOpen size={16} className="shrink-0" />
        <span className="hidden truncate sm:inline">{cwd ? baseName(cwd) : "Select project"}</span>
        <ChevronDown size={14} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div data-side={placement === "up" ? "top" : "bottom"} className={cn(
            "absolute left-0 z-50 w-80 max-w-[calc(100vw-2rem)] vd-menu rounded-xl border border-border bg-surface-raised shadow-lg overflow-hidden",
            placement === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}>
            <div className="flex items-center gap-2 px-3 border-b border-border">
              <Search size={13} className="text-text-faint shrink-0" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const first = [...recentShown, ...reposShown, ...knownFiltered][0];
                  if (first) select(first.path);
                }}
                placeholder="Search projects and repositories…"
                aria-label="Search projects"
                className="w-full bg-transparent py-2.5 text-sm text-text placeholder:text-text-faint focus:outline-none"
              />
            </div>
            <div className="overflow-y-auto py-1" style={{ maxHeight: listMaxH }}>
              {recentShown.length > 0 && (
                <>
                  {section("Recent")}
                  {recentShown.map((p) => row(p, p.branch ? <FolderGit2 size={13} /> : <FolderOpen size={13} />))}
                </>
              )}
              {reposShown.length > 0 && (
                <>
                  {section("Repositories")}
                  {reposShown.map((p) => row(p, <FolderGit2 size={13} />))}
                </>
              )}
              {needle && !recentShown.length && !reposShown.length && !knownFiltered.length && (
                <div className="px-3 py-3 text-xs text-text-faint">No projects match.</div>
              )}
              {knownFiltered.length > 0 && (
                <>
                  {section("Projects")}
                  {knownFiltered.map((p) => row(p, <FolderOpen size={13} />))}
                </>
              )}
              {home && !seen.has(home) && !needle && (
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
