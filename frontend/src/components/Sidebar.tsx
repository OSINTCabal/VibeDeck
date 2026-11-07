import * as React from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Plus, Search, PanelLeft, Trash2, ChevronDown, X,
  Network, Clock3, LayoutGrid, Folder,
} from "lucide-react";
import { getProjects } from "@/lib/api";
import { cn } from "@/lib/utils";
import { LANES, type useSessions, type useHealth } from "@/hooks/useSessions";
import type { Lane, Session } from "@/lib/types";
import { AccountMenu } from "./AccountMenu";
import { MistralLogo } from "./Logo";

function startOfDay(ts: number): number {
  const d = new Date(ts * 1000);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
}

/** Group sessions like the webapp history: Recent / Yesterday / Last 7 days / Last 30 days / Older. */
function groupByDay(sessions: Session[]): { label: string; items: Session[] }[] {
  const today = startOfDay(Date.now() / 1000);
  const yesterday = today - 86400;
  const weekAgo = today - 7 * 86400;
  const monthAgo = today - 30 * 86400;
  const groups: { label: string; items: Session[] }[] = [
    { label: "Recent", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Last 7 days", items: [] },
    { label: "Last 30 days", items: [] },
    { label: "Older", items: [] },
  ];
  for (const s of sessions) {
    if (s.updated_at >= today) groups[0].items.push(s);
    else if (s.updated_at >= yesterday) groups[1].items.push(s);
    else if (s.updated_at >= weekAgo) groups[2].items.push(s);
    else if (s.updated_at >= monthAgo) groups[3].items.push(s);
    else groups[4].items.push(s);
  }
  return groups.filter((g) => g.items.length > 0);
}

export function Sidebar({
  lane, setLane, sessions, create, remove, health, collapsed, onToggleCollapse,
}: {
  lane: Lane; setLane: (l: Lane) => void;
  sessions: Session[];
  create: ReturnType<typeof useSessions>["create"];
  remove: ReturnType<typeof useSessions>["remove"];
  health: ReturnType<typeof useHealth>;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query, setQuery] = React.useState("");
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [contextOpen, setContextOpen] = React.useState(() => localStorage.getItem("vibedeck.context-open") !== "false");
  const [projects, setProjects] = React.useState<{ path: string; name: string }[]>([]);
  const [projectsError, setProjectsError] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    let closed = false;
    getProjects().then(data => {
      if (!closed) setProjects([...new Map([...data.recent, ...data.known].map(p => [p.path, p])).values()]);
    }).catch(() => { if (!closed) setProjectsError(true); });
    return () => { closed = true; };
  }, []);

  React.useEffect(() => { setMenuOpen(false); }, [location, collapsed]);
  React.useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  const filtered = sessions.filter((s) => s.lane === lane);
  const visible = query.trim()
    ? filtered.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase()))
    : filtered;
  const groups = React.useMemo(() => groupByDay(visible), [visible]);

  const newSession = async () => {
    // cwd defaults to the user's home on the backend
    const s = await create({ cwd: "", lane });
    navigate(`/sessions/${s.id}`);
  };

  const user = health?.user || "user";

  const iconBtn =
    "h-7 w-7 grid place-items-center rounded-md text-text-faint hover:text-text hover:bg-surface-muted transition-colors";

  return (
    <aside
      className={cn(
        "shrink-0 h-full bg-sidebar overflow-hidden transition-[width] duration-200",
        collapsed ? "w-0" : "w-64 border-r border-sidebar-border",
      )}
    >
      <div className="w-64 h-full flex flex-col">
        <div className="px-3 pt-3 pb-2 shrink-0 flex items-center gap-1.5">
          <div ref={menuRef} className="relative" onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false);
          }}>
            <button
              ref={menuButtonRef}
              type="button"
              aria-label="Vibe menu"
              aria-expanded={menuOpen}
              aria-controls="vibe-navigation"
              onClick={() => setMenuOpen(open => !open)}
              className={cn("flex h-8 items-center gap-1.5 rounded-md px-1 text-text transition-colors hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary", menuOpen && "bg-surface-muted")}
            >
              <MistralLogo size={20} className="shrink-0" />
              <span className="text-[15px] font-semibold leading-none">Vibe</span>
              <ChevronDown size={12} className={cn("text-text-faint transition-transform duration-150 motion-reduce:transition-none", menuOpen && "rotate-180")} />
            </button>
            {menuOpen && <nav id="vibe-navigation" aria-label="Vibe navigation" className="absolute left-0 top-full z-50 mt-1 w-[232px] max-h-[calc(100vh-8rem)] overflow-y-auto rounded-lg border border-border bg-surface-raised p-1.5 shadow-xl animate-slide-up">
              <a onClick={() => setMenuOpen(false)} href="https://console.mistral.ai/" target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-md px-2.5 py-2 text-sm text-text hover:bg-surface-muted transition-colors"><span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded bg-primary"><MistralLogo size={18} className="fill-white" /></span>Studio</a>
              {[{to:"/workspace/docs",label:"Docs & API"},{to:"/workspace/admin",label:"Admin"}].map(item => <NavLink key={item.to} to={item.to} className="flex items-center gap-3 rounded-md px-2.5 py-2 text-sm text-text hover:bg-surface-muted transition-colors"><span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded bg-text-faint"><MistralLogo size={18} className="fill-white" /></span>{item.label}</NavLink>)}
            </nav>}
          </div>
          <div className="flex-1" />
          <button
            onClick={() => { setSearchOpen((o) => !o); if (searchOpen) setQuery(""); }}
            title="Search sessions"
            aria-label="Search sessions"
            className={iconBtn}
          >
            <Search size={15} />
          </button>
          <button
            onClick={onToggleCollapse}
            title="Hide sidebar"
            aria-label="Hide sidebar"
            className={iconBtn}
          >
            <PanelLeft size={15} />
          </button>
        </div>

        {/* search — filters the session list */}
        {searchOpen && (
          <div className="px-3 pb-2 shrink-0">
            <div className="flex items-center gap-2 rounded-md bg-surface-muted px-2">
              <Search size={13} className="text-text-faint shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sessions…"
                className="w-full bg-transparent py-1.5 text-sm text-text placeholder:text-text-faint focus:outline-none"
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="Clear search" className="text-text-faint transition-colors hover:text-text">
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* lane tabs — segmented Work | Code, like the webapp */}
        <div className="mx-3 mb-2 shrink-0 grid grid-cols-2 gap-1 rounded-lg bg-sidebar-accent p-0.5">
          {LANES.map((l) => (
            <button
              key={l.key}
              type="button"
              aria-pressed={lane === l.key}
              onClick={() => setLane(l.key)}
              title={l.hint}
              className={cn(
                "rounded-md py-1.5 text-sm font-medium transition-colors",
                lane === l.key
                  ? "bg-sidebar text-text shadow-sm ring-1 ring-border/60"
                  : "text-text-muted hover:text-text hover:bg-surface-muted/50",
              )}
            >
              {l.label}
            </button>
          ))}
        </div>

        {/* new chat / new session */}
        <div className="px-3 mb-2 shrink-0">
          <button
            onClick={newSession}
            className="w-full flex items-center gap-2 rounded-md bg-surface-muted hover:bg-surface-muted/60 px-2.5 py-2 text-sm text-text transition-colors"
          >
            <Plus size={15} className="text-text-muted" />
            New {lane === "code" ? "Session" : "Chat"}
          </button>
        </div>

        {/* Context, projects and history share one scroll area on shorter windows. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-2">
          <button type="button" aria-expanded={contextOpen} aria-controls="sidebar-context" onClick={() => {
            setContextOpen(!contextOpen);
            localStorage.setItem("vibedeck.context-open", String(!contextOpen));
          }} className="w-full flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-text hover:bg-surface-muted transition-colors">
            <Network size={15} />Context
            <ChevronDown size={13} className={cn("ml-auto text-text-faint transition-transform duration-200 motion-reduce:transition-none", !contextOpen && "-rotate-90")} />
          </button>
          <div className="context-disclosure" data-open={contextOpen} aria-hidden={!contextOpen} ref={node => node?.toggleAttribute("inert", !contextOpen)}>
          <div className="min-h-0 overflow-hidden">
          <nav id="sidebar-context" aria-label="Context" className="ml-5 border-l border-border pl-2">
            {lane === "work" ? <>
              <WorkspaceItem section="skills" label="Skills" />
              <WorkspaceItem section="knowledge" label="Knowledge" />
              <WorkspaceItem section="connectors" label="Connectors" />
              <WorkspaceItem section="libraries" label="Libraries" />
              <WorkspaceItem section="instructions" label="Instructions" />
            </> : <>
              <NavItem to="/skills" label="Skills" />
              <NavItem to="/connectors" label="Connectors" />
            </>}
          </nav>
          </div>
          </div>
          {lane === "work"
            ? <WorkspaceItem section="scheduled" icon={Clock3} label="Scheduled" />
            : <NavItem to="/extensions" icon={LayoutGrid} label="Extensions" />}
          {lane === "work" && <p className="px-3 pt-1 text-[11px] text-text-faint">Shared with your Mistral web workspace.</p>}
          <div className="px-3 pt-6 pb-2 text-xs text-text-muted">Projects</div>
          {projects.map(project => <NavLink key={project.path} to={`/?project=${encodeURIComponent(project.path)}`} className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-text hover:bg-surface-muted transition-colors" title={project.path}>
            <Folder size={15} className="shrink-0" /><span className="truncate">{project.name}</span>
          </NavLink>)}
          {projectsError && <p className="px-3 text-xs text-text-faint">Projects could not be loaded.</p>}
          {!projects.length && !projectsError && <p className="px-3 text-xs text-text-faint">Choose a folder to start a project.</p>}
          <div className="px-3 pt-6 pb-1 text-xs text-text-muted">Sessions</div>
          {groups.length === 0 && (
            <div className="px-2 py-3 text-xs text-text-faint">
              {query.trim() ? "No sessions match." : "No sessions yet. Start a new one."}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label} className="mb-1">
              <div className="px-2 pt-2 pb-1 text-xs text-text-faint">
                {g.label}
              </div>
              {g.items.map((s) => (
                <SessionItem key={s.id} s={s} remove={remove} />
              ))}
            </div>
          ))}
        </div>

        {/* user profile + status — pinned footer, never cut off */}
        <div className="px-3 py-2 border-t border-sidebar-border shrink-0">
          <AccountMenu user={user} />
          <div className="mt-1 px-1 flex items-center gap-2 text-[11px] text-text-faint">
            <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", health?.ok ? "bg-success" : "bg-danger")} />
            <span className="truncate">{health?.ok ? "Sidecar connected" : "Sidecar offline"}</span>
            {health && (
              <span className="ml-auto shrink-0 font-mono truncate max-w-[110px]" title={health.default_model}>
                {health.default_model}
              </span>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function SessionItem({
  s, remove,
}: {
  s: Session;
  remove: ReturnType<typeof useSessions>["remove"];
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname === `/sessions/${s.id}`;
  return (
    <NavLink
      to={`/sessions/${s.id}`}
      className={({ isActive }) => cn(
        "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        isActive
          ? "bg-surface-muted text-text"
          : "text-text-muted hover:bg-surface-muted/50 hover:text-text",
      )}
    >
      <span className={cn(
        "h-1.5 w-1.5 rounded-full shrink-0",
        s.status === "running" ? "bg-primary animate-blink" : "bg-text-faint",
      )} />
      <span className="truncate flex-1">{s.title}</span>
      {s.origin === "vibe" && (
        <span
          title="Session from the vibe CLI — continue it here or in the terminal"
          className="shrink-0 rounded border border-border px-1 py-px text-[9px] font-medium uppercase tracking-wider text-text-faint"
        >
          CLI
        </span>
      )}
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          remove(s.id).then(() => {
            if (active) navigate("/");
          }).catch(() => {});
        }}
        title="Delete session"
        aria-label={`Delete session ${s.title}`}
        className={cn(
          "shrink-0 rounded p-0.5 text-text-faint hover:text-danger transition-colors",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
      >
        <Trash2 size={12} />
      </button>
    </NavLink>
  );
}

function NavItem({ to, icon: Icon, label }: { to: string; icon?: React.ElementType; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn(
        "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
        isActive
          ? "bg-surface-muted text-text"
          : "text-text-muted hover:text-text hover:bg-surface-muted/50",
      )}
    >
      {Icon && <Icon size={15} />}
      {label}
    </NavLink>
  );
}

function WorkspaceItem({ section, label, icon: Icon }: { section: string; label: string; icon?: React.ElementType }) {
  return <NavLink to={"/workspace/" + section} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-text-muted hover:text-text hover:bg-surface-muted/50 transition-colors">
    {Icon && <Icon size={15} />}{label}
  </NavLink>;
}
