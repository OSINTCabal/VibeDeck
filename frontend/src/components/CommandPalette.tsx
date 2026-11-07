import * as React from "react";
import { useNavigate } from "react-router-dom";
import {
  Boxes, Code2, FlaskConical, FolderOpen, Home, MessageSquare, PanelLeft,
  Plus, Puzzle, Search, Settings, LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isFrameless, closeWindow } from "@/lib/windowControls";
import type { Lane, Session } from "@/lib/types";

interface Command {
  id: string;
  group: "Actions" | "Navigation" | "Sessions";
  label: string;
  hint?: string;
  keywords: string;
  icon: React.ElementType;
  run: () => void | Promise<void>;
}

/** Subsequence fuzzy match; higher score = better. -1 = no match. */
function fuzzy(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++;
      streak++;
      score += 1 + (streak > 1 ? 0.5 : 0);
      if (i === 0 || /[\s\-_/.()]/.test(t[i - 1])) score += 0.5; // word start
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

/**
 * Quick-access command palette — the functionality behind the composer's
 * "Type / for quick access" placeholder. Opens with Ctrl/Cmd+K anywhere, or
 * with "/" when not typing (or when typing in the main composer, like the
 * webapp). Arrow keys navigate, Enter runs, Escape closes.
 */
export function CommandPalette({
  lane, setLane, sessions, create, onToggleSidebar,
}: {
  lane: Lane;
  setLane: (l: Lane) => void;
  sessions: Session[];
  create: (opts: { cwd: string; lane: Lane }) => Promise<Session>;
  onToggleSidebar: () => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  const commands = React.useMemo<Command[]>(() => {
    const cmds: Command[] = [
      {
        id: "new", group: "Actions",
        label: lane === "code" ? "New Session" : "New Chat",
        hint: lane === "code" ? "code lane" : "work lane",
        keywords: "new chat session start create begin",
        icon: Plus,
        run: async () => {
          const s = await create({ cwd: "", lane });
          navigate(`/sessions/${s.id}`);
        },
      },
      {
        id: "toggle-sidebar", group: "Actions",
        label: "Toggle sidebar",
        keywords: "sidebar collapse hide show panel",
        icon: PanelLeft,
        run: () => onToggleSidebar(),
      },
      {
        id: "lane-work", group: "Actions",
        label: "Switch to Work lane",
        hint: "ask anything",
        keywords: "work lane chat ask mode",
        icon: MessageSquare,
        run: () => setLane("work"),
      },
      {
        id: "lane-code", group: "Actions",
        label: "Switch to Code lane",
        hint: "build & edit",
        keywords: "code lane build edit agent mode",
        icon: Code2,
        run: () => setLane("code"),
      },
      {
        id: "home", group: "Navigation",
        label: "Home",
        keywords: "welcome start new",
        icon: Home,
        run: () => navigate("/"),
      },
      {
        id: "studio-playground", group: "Navigation",
        label: "API tools: Playground",
        keywords: "studio playground prompt completion test",
        icon: FlaskConical,
        run: () => navigate("/studio/playground"),
      },
      {
        id: "studio-models", group: "Navigation",
        label: "API tools: Models",
        keywords: "studio models catalog list",
        icon: FlaskConical,
        run: () => navigate("/studio/models"),
      },
      {
        id: "studio-usage", group: "Navigation",
        label: "Usage",
        keywords: "studio usage billing quota spend",
        icon: FlaskConical,
        run: () => navigate("/usage"),
      },
      {
        id: "studio-agents", group: "Navigation",
        label: "API tools: Agents",
        keywords: "studio agents custom",
        icon: FlaskConical,
        run: () => navigate("/studio/agents"),
      },
      {
        id: "studio-observability", group: "Navigation",
        label: "API tools: Observability",
        keywords: "studio observability logs traces metrics",
        icon: FlaskConical,
        run: () => navigate("/studio/observability"),
      },
      {
        id: "skills", group: "Navigation",
        label: "Skills",
        keywords: "skills list library",
        icon: Puzzle,
        run: () => navigate("/skills"),
      },
      ...["Knowledge", "Libraries", "Connectors", "Instructions", "Scheduled", "Extensions"].map(label => ({
        id: label.toLowerCase(), group: "Navigation" as const,
        label, keywords: `${label.toLowerCase()} context workspace`, icon: Boxes,
        run: () => navigate(label === "Extensions" ? "/extensions" : `/workspace/${label.toLowerCase()}`),
      })),
      {
        id: "mcp", group: "Navigation",
        label: "MCP",
        hint: "servers",
        keywords: "mcp servers tools connectors",
        icon: Boxes,
        run: () => navigate("/mcp"),
      },
      {
        id: "settings", group: "Navigation",
        label: "Settings",
        keywords: "settings preferences config api key",
        icon: Settings,
        run: () => navigate("/settings"),
      },
    ];
    if (isFrameless()) {
      cmds.push({
        id: "quit", group: "Actions",
        label: "Quit VibeDeck",
        keywords: "quit exit close app window",
        icon: LogOut,
        run: () => closeWindow(),
      });
    }
    // recent sessions in the current lane
    const recent = sessions
      .filter((s) => s.lane === lane)
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, 5);
    for (const s of recent) {
      cmds.push({
        id: `session-${s.id}`, group: "Sessions",
        label: s.title || "Untitled session",
        hint: s.cwd,
        keywords: `session chat ${s.title} ${s.cwd}`,
        icon: FolderOpen,
        run: () => navigate(`/sessions/${s.id}`),
      });
    }
    return cmds;
  }, [lane, sessions, create, navigate, setLane, onToggleSidebar]);

  const filtered = React.useMemo(() => {
    const q = query.trim();
    const scored = commands
      .map((c) => {
        const full = fuzzy(q, `${c.label} ${c.keywords} ${c.group}`);
        if (full < 0) return { c, score: -1 };
        const label = fuzzy(q, c.label);
        // matches in the label dominate keyword/group matches
        return { c, score: full + (label >= 0 ? label + 5 : 0) };
      })
      .filter((x) => x.score >= 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => x.c);
  }, [commands, query]);

  // group the filtered commands, preserving first-seen group order
  const groups = React.useMemo(() => {
    const out: { label: string; items: Command[] }[] = [];
    for (const c of filtered) {
      let g = out.find((g) => g.label === c.group);
      if (!g) {
        g = { label: c.group, items: [] };
        out.push(g);
      }
      g.items.push(c);
    }
    return out;
  }, [filtered]);

  const flat = React.useMemo(() => groups.flatMap((g) => g.items), [groups]);

  React.useEffect(() => setActive(0), [query, open]);

  // keep the active item scrolled into view
  React.useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const openPalette = React.useCallback(() => {
    setQuery("");
    setOpen(true);
  }, []);

  const closePalette = React.useCallback(() => setOpen(false), []);

  // global triggers: Ctrl/Cmd+K anywhere; "/" when not typing (or in the composer)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) closePalette(); else openPalette();
        return;
      }
      if (e.key === "/" && !mod && !e.altKey && !e.isComposing) {
        const t = e.target as HTMLElement | null;
        const editable = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        const emptyComposer = !!t?.closest?.("[data-vd-composer]") &&
          (t as HTMLTextAreaElement).value === "" && !t?.matches(":disabled");
        if (!editable || emptyComposer) {
          e.preventDefault();
          openPalette();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openPalette, closePalette]);

  // Escape closes even if focus somehow left the input
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closePalette]);

  if (!open) return null;

  const runCommand = (c: Command) => {
    closePalette();
    Promise.resolve(c.run()).catch(() => {});
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = flat[active];
      if (c) runCommand(c);
    } else if (e.key === "Tab") {
      e.preventDefault(); // keep focus in the palette
    }
  };

  let idx = -1;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex items-start justify-center pt-[16vh] animate-fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget) closePalette(); }}
    >
      <div className="w-full max-w-xl mx-4 rounded-xl border border-border bg-surface-raised shadow-2xl overflow-hidden animate-slide-up">
        <div className="flex items-center gap-2 px-3 border-b border-border">
          <Search size={15} className="text-text-faint shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Type a command…"
            aria-label="Command palette"
            className="flex-1 bg-transparent py-3 text-[15px] text-text placeholder:text-text-faint focus:outline-none"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-faint font-mono">
            esc
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          {flat.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-text-faint">
              No commands match.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-faint">
                {g.label}
              </div>
              {g.items.map((c) => {
                idx += 1;
                const i = idx;
                const isActive = i === active;
                return (
                  <button
                    key={c.id}
                    data-idx={i}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => runCommand(c)}
                    className={cn(
                      "w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors",
                      isActive
                        ? "bg-surface-muted text-text"
                        : "text-text-muted",
                    )}
                  >
                    <c.icon size={15} className="shrink-0 text-text-faint" />
                    <span className="flex-1 truncate">{c.label}</span>
                    {c.hint && (
                      <span className="shrink-0 max-w-[180px] truncate font-mono text-[11px] text-text-faint">
                        {c.hint}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 px-3 py-2 border-t border-border text-[11px] text-text-faint">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> select</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
