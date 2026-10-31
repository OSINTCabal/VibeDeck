import * as React from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Plus, Search, PanelLeft, Trash2, ChevronDown, X,
  Network, Clock3, LayoutGrid, MoreHorizontal, Pencil,
} from "lucide-react";
import { getProjects, patchSession } from "@/lib/api";
import { SessionMenu } from "./SessionMenu";
import { cn, modelLabel } from "@/lib/utils";
import { LANES, type useSessions, type useHealth } from "@/hooks/useSessions";
import type { Lane, Session } from "@/lib/types";
import { AccountMenu } from "./AccountMenu";
import { MistralLogo } from "./Logo";
import { menuItem, menuPanel, usePresence } from "./ui";

/** One sidebar row: 32px tall, 10px inset, 8px radius — the webapp's menu button. */
const row = "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-150";
const rowIdle = "text-text hover:bg-surface-muted";
const rowActive = "bg-surface-muted text-text";
const sectionLabel = "flex h-8 items-center px-2.5 text-xs font-medium text-text-faint";

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
  lane, setLane, sessions, remove, health, collapsed, onToggleCollapse,
}: {
  lane: Lane; setLane: (l: Lane) => void;
  sessions: Session[];
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
  const menuPresence = usePresence(menuOpen);
  const [collapsedProjects, setCollapsedProjects] = React.useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("vibedeck.collapsed-projects") || "[]"); } catch { return []; }
  });
  const toggleProject = (path: string) => setCollapsedProjects(prev => {
    const next = prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path];
    localStorage.setItem("vibedeck.collapsed-projects", JSON.stringify(next));
    return next;
  });
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
  // Sessions started in a listed project nest under it, like the webapp;
  // the rest stay in the dated Sessions list.
  const projectPaths = React.useMemo(() => new Set(projects.map(p => p.path)), [projects]);
  const loose = React.useMemo(() => visible.filter(s => !projectPaths.has(s.cwd)), [visible, projectPaths]);
  const groups = React.useMemo(() => groupByDay(loose), [loose]);

  // The welcome screen creates the session with the first message, so an
  // unused "New session" leaves nothing behind.
  const newSession = () => navigate("/");

  const user = health?.user || "user";

  const iconBtn =
    "h-8 w-8 grid place-items-center rounded-md text-text-muted hover:text-text hover:bg-surface-muted transition-colors duration-150";

  return (
    <aside
      className={cn(
        "shrink-0 h-full bg-sidebar overflow-hidden transition-[width] duration-200 ease-in-out",
        collapsed ? "w-0" : "w-[260px] border-r border-sidebar-border",
      )}
    >
      <div className="w-[260px] h-full flex flex-col">
        <div className="px-3.5 pt-2.5 pb-2 shrink-0 flex items-center gap-1">
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
              className={cn("flex h-8 items-center gap-2 rounded-md pl-1 pr-1.5 text-text transition-colors hover:bg-surface-muted active:bg-surface-muted/70", menuOpen && "bg-surface-muted")}
            >
              <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary">
                <MistralLogo size={15} mono className="fill-white" />
              </span>
              <span className="text-base font-semibold leading-none">Vibe</span>
              <ChevronDown size={16} className={cn("text-text-muted transition-transform duration-150 motion-reduce:transition-none", menuOpen && "rotate-180")} />
            </button>
            {menuPresence.mounted && <nav id="vibe-navigation" aria-label="Vibe navigation" data-state={menuPresence.state} className={cn(menuPanel, "absolute left-0 top-full z-50 mt-1 flex w-[232px] max-h-[calc(100vh-8rem)] flex-col gap-1 overflow-y-auto")}>
              <a onClick={() => setMenuOpen(false)} href="https://console.mistral.ai/" target="_blank" rel="noreferrer" className={menuItem}><span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary"><MistralLogo size={15} mono className="fill-white" /></span>Studio</a>
              {[{to:"/workspace/docs",label:"Docs & API"},{to:"/workspace/admin",label:"Admin"}].map(item => <NavLink key={item.to} to={item.to} className={menuItem}><span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-text-faint"><MistralLogo size={15} mono className="fill-white" /></span>{item.label}</NavLink>)}
            </nav>}
          </div>
          <div className="flex-1" />
          <button
            onClick={() => { setSearchOpen((o) => !o); if (searchOpen) setQuery(""); }}
            title="Search sessions"
            aria-label="Search sessions"
            aria-pressed={searchOpen}
            className={cn(iconBtn, searchOpen && "bg-surface-muted text-text")}
          >
            <Search size={16} />
          </button>
          <button
            onClick={onToggleCollapse}
            title="Hide sidebar"
            aria-label="Hide sidebar"
            className={iconBtn}
          >
            <PanelLeft size={16} />
          </button>
        </div>

        {/* search — filters the session list */}
        {searchOpen && (
          <div className="px-3.5 pb-2 shrink-0 animate-fade-in">
            <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2.5 transition-colors focus-within:border-border-strong">
              <Search size={14} className="text-text-faint shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sessions…"
                className="w-full bg-transparent text-sm text-text placeholder:text-text-faint focus:outline-none"
              />
              {query && (
                <button onClick={() => setQuery("")} aria-label="Clear search" className="text-text-faint transition-colors hover:text-text">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* lane tabs — segmented Work | Code, like the webapp */}
        <div className="mx-3.5 mb-2 shrink-0 grid h-9 grid-cols-2 gap-1 rounded-md bg-sidebar-accent p-0.5">
          {LANES.map((l) => (
            <button
              key={l.key}
              type="button"
              aria-pressed={lane === l.key}
              onClick={() => setLane(l.key)}
              title={l.hint}
              className={cn(
                "rounded-sm text-base font-medium transition-colors duration-150",
                lane === l.key
                  ? "vd-segment-active bg-sidebar text-text"
                  : "text-text-muted hover:text-text",
              )}
            >
              {l.label}
            </button>
          ))}
        </div>

        {/* Navigation, projects and history share one scroll area on shorter windows. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-3.5 pb-2">
          <button
            onClick={newSession}
            className={cn(row, location.pathname === "/" && !location.search ? rowActive : rowIdle)}
          >
            <Plus size={16} className="shrink-0" />
            New {lane === "code" ? "session" : "chat"}
          </button>
          <button type="button" aria-expanded={contextOpen} aria-controls="sidebar-context" onClick={() => {
            setContextOpen(!contextOpen);
            localStorage.setItem("vibedeck.context-open", String(!contextOpen));
          }} className={cn(row, rowIdle, "group")}>
            <Network size={16} className="shrink-0" />Context
            <ChevronDown size={16} className={cn("vd-disclosure-chevron ml-auto text-text-muted motion-reduce:transition-none", !contextOpen && "-rotate-90")} />
          </button>
          <div className="context-disclosure" data-open={contextOpen} aria-hidden={!contextOpen} ref={node => node?.toggleAttribute("inert", !contextOpen)}>
          <div className="min-h-0 overflow-hidden">
          <nav id="sidebar-context" aria-label="Context">
            {lane === "work" ? <>
              <WorkspaceItem section="skills" label="Skills" nested />
              <WorkspaceItem section="knowledge" label="Knowledge" nested />
              <WorkspaceItem section="connectors" label="Connectors" nested />
              <WorkspaceItem section="libraries" label="Libraries" nested />
              <WorkspaceItem section="instructions" label="Instructions" nested />
            </> : <>
              <NavItem to="/skills" label="Skills" nested />
              <NavItem to="/connectors" label="Connectors" nested />
            </>}
          </nav>
          </div>
          </div>
          {lane === "work"
            ? <WorkspaceItem section="scheduled" icon={Clock3} label="Scheduled" />
            : <NavItem to="/extensions" icon={LayoutGrid} label="Extensions" />}
          {lane === "work" && <p className="px-2.5 pt-1 text-xs text-text-faint">Shared with your Mistral web workspace.</p>}
          <div className={cn(sectionLabel, "mt-4")}>Projects</div>
          {projects.map(project => {
            const nested = visible.filter(s => s.cwd === project.path);
            const folded = collapsedProjects.includes(project.path) && !query.trim();
            return <div key={project.path}>
              <div className="group relative">
                <NavLink to={`/?project=${encodeURIComponent(project.path)}`} className={({ isActive }) => cn(row, "pr-9", isActive && location.search.includes(encodeURIComponent(project.path)) ? rowActive : rowIdle)} title={project.path}>
                  <ProjectMark name={project.name} /><span className="truncate flex-1">{project.name}</span>
                  {nested.length > 0 && <span className="shrink-0 text-xs text-text-faint tabular-nums group-hover:opacity-0">{nested.length}</span>}
                </NavLink>
                {nested.length > 0 && <button
                  type="button"
                  onClick={() => toggleProject(project.path)}
                  aria-expanded={!folded}
                  aria-label={`${folded ? "Show" : "Hide"} sessions in ${project.name}`}
                  title={folded ? "Show sessions" : "Hide sessions"}
                  className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-sm text-text-muted opacity-0 transition-[opacity,background-color] hover:bg-surface-muted hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <ChevronDown size={16} className={cn("transition-transform duration-150", folded && "-rotate-90")} />
                </button>}
              </div>
              <div className="vd-collapse" data-open={!folded}>
                <div aria-hidden={folded} ref={node => node?.toggleAttribute("inert", folded)}>
                  {nested.map(s => <SessionItem key={s.id} s={s} remove={remove} nested />)}
                </div>
              </div>
            </div>;
          })}
          {projectsError && <p className="px-2.5 text-xs text-text-faint">Projects could not be loaded.</p>}
          {!projects.length && !projectsError && <p className="px-2.5 text-xs text-text-faint">Choose a folder to start a project.</p>}
          <div className={cn(sectionLabel, "mt-4")}>Sessions</div>
          {groups.length === 0 && (
            <div className="px-2.5 py-1 text-xs text-text-faint">
              {query.trim() ? "No sessions match." : visible.length ? "All sessions are listed under their projects." : "No sessions yet. Start a new one."}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label} className="mb-1">
              <div className="px-2.5 pt-2 pb-1 text-xs text-text-faint">
                {g.label}
              </div>
              {g.items.map((s) => (
                <SessionItem key={s.id} s={s} remove={remove} />
              ))}
            </div>
          ))}
        </div>

        {/* user profile + status — pinned footer, never cut off */}
        <div className="px-3.5 pt-1 pb-2.5 shrink-0">
          <AccountMenu user={user} />
          <div className="mt-1 px-3 flex items-center gap-2 text-[11px] text-text-faint">
            <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", health?.ok ? "bg-success" : "bg-danger")} />
            <span className="truncate">{health?.ok ? "Sidecar connected" : "Sidecar offline"}</span>
            {health && (
              <span className="ml-auto shrink-0 truncate max-w-[110px]" title={health.default_model}>
                {modelLabel(health.default_model)}
              </span>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

const MARK_COLORS = ["bg-[#fa500f]", "bg-[#e0a100]", "bg-[#2f9e6b]", "bg-[#2f7fd8]", "bg-[#8b5cf6]", "bg-[#d9467a]", "bg-[#0e9fae]"];

/** 16px initial badge for a project, coloured from its name. */
function ProjectMark({ name }: { name: string }) {
  const hash = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return (
    <span aria-hidden="true" className={cn("grid h-4 w-4 shrink-0 place-items-center rounded-[4px] text-[10px] font-semibold uppercase leading-none text-white", MARK_COLORS[hash % MARK_COLORS.length])}>
      {name.trim().charAt(0) || "?"}
    </span>
  );
}

/** The 1px tree guide beside nested rows; the active row lights a short orange segment. */
function TreeLine({ active }: { active: boolean }) {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute -top-px -bottom-px left-4 flex w-px items-center">
      <span className="absolute inset-y-0 w-full bg-border" />
      {active && <span className="relative h-3/5 w-full bg-primary" />}
    </span>
  );
}

function SessionItem({
  s, remove, nested = false,
}: {
  s: Session;
  remove: ReturnType<typeof useSessions>["remove"];
  nested?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const active = location.pathname === `/sessions/${s.id}`;
  const [renaming, setRenaming] = React.useState(false);
  const [title, setTitle] = React.useState(s.title);
  React.useEffect(() => { setTitle(s.title); }, [s.title]);
  const save = async () => {
    const t = title.trim();
    setRenaming(false);
    if (!t || t === s.title) { setTitle(s.title); return; }
    try {
      await patchSession(s.id, { title: t });
      window.dispatchEvent(new Event("vibedeck:sessions"));
    } catch { setTitle(s.title); }
  };
  if (renaming) {
    return (
      <div className={cn(row, "relative bg-surface-muted", nested && "pl-[38px]")}>
        {nested && <TreeLine active={active} />}
        <input
          autoFocus
          aria-label="Session title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={e => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") { setTitle(s.title); setRenaming(false); }
          }}
          className="w-full min-w-0 bg-transparent text-sm text-text focus:outline-none"
        />
      </div>
    );
  }
  return (
    <NavLink
      to={`/sessions/${s.id}`}
      className={({ isActive }) => cn(
        row, "group relative pr-1",
        nested && "pl-[38px]",
        isActive ? rowActive : "text-text-muted hover:bg-surface-muted hover:text-text",
      )}
    >
      {nested && <TreeLine active={active} />}
      {s.status === "running" && <span className="h-1.5 w-1.5 rounded-full shrink-0 bg-primary animate-blink" aria-label="Running" />}
      <span className="truncate flex-1">{s.title}</span>
      {s.origin === "vibe" && (
        <span
          title="Session from the vibe CLI — continue it here or in the terminal"
          className="shrink-0 rounded-sm border border-border px-1 py-px text-[9px] font-medium uppercase tracking-wider text-text-faint"
        >
          CLI
        </span>
      )}
      <span className={cn("shrink-0", active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100")}>
        <SessionMenu
          label={`Actions for ${s.title}`}
          trigger={<MoreHorizontal size={16} />}
          triggerClassName="grid h-6 w-6 place-items-center rounded-sm text-text-faint transition-colors hover:bg-surface-muted hover:text-text"
          items={[
            { label: "Rename", icon: Pencil, onSelect: () => setRenaming(true) },
            { label: "Delete session", icon: Trash2, danger: true, onSelect: () => {
              remove(s.id).then(() => { if (active) navigate("/"); }).catch(() => {});
            } },
          ]}
        />
      </span>
    </NavLink>
  );
}

function NavItem({ to, icon: Icon, label, nested = false }: { to: string; icon?: React.ElementType; label: string; nested?: boolean }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) => cn(row, "relative", nested && "pl-[38px]", isActive ? rowActive : nested ? "text-text-muted hover:bg-surface-muted hover:text-text" : rowIdle)}
    >
      {({ isActive }) => <>
        {nested && <TreeLine active={isActive} />}
        {Icon && <Icon size={16} className="shrink-0" />}
        {label}
      </>}
    </NavLink>
  );
}

function WorkspaceItem({ section, label, icon: Icon, nested = false }: { section: string; label: string; icon?: React.ElementType; nested?: boolean }) {
  return <NavLink to={"/workspace/" + section} className={({ isActive }) => cn(row, "relative", nested && "pl-[38px]", isActive ? rowActive : nested ? "text-text-muted hover:bg-surface-muted hover:text-text" : rowIdle)}>
    {({ isActive }) => <>
      {nested && <TreeLine active={isActive} />}
      {Icon && <Icon size={16} className="shrink-0" />}{label}
    </>}
  </NavLink>;
}
