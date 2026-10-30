import * as React from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn, modelLabel } from "@/lib/utils";
import { getAgents, getConfig, studioModels } from "@/lib/api";
import type { AgentInfo, ModelInfo } from "@/lib/types";

// ---------------------------------------------------------------- dropdown placement

/**
 * Menus open upward by default (composer sits at the bottom), but flip
 * downward when there is not enough room above the anchor — and cap the
 * list height to the available space so the menu is never cut off.
 */
function useDropdownPlacement(
  open: boolean,
  anchorRef: React.RefObject<HTMLButtonElement | null>,
  menuHeight: number,
  searchHeight = 0,
) {
  const [placement, setPlacement] = React.useState<"up" | "down">("up");
  const [listMaxH, setListMaxH] = React.useState(288);
  React.useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const spaceAbove = r.top - 8;
    const spaceBelow = window.innerHeight - r.bottom - 8;
    if (spaceAbove >= menuHeight || spaceAbove >= spaceBelow) {
      setPlacement("up");
      setListMaxH(Math.max(120, Math.min(288, spaceAbove - searchHeight)));
    } else {
      setPlacement("down");
      setListMaxH(Math.max(120, Math.min(288, spaceBelow - searchHeight)));
    }
  }, [open, anchorRef, menuHeight, searchHeight]);
  return { placement, listMaxH };
}

// ---------------------------------------------------------------- model list (cached app-wide)

let modelCache: ModelInfo[] | null = null;
let modelPromise: Promise<ModelInfo[]> | null = null;

export function useModels(): { models: ModelInfo[]; loading: boolean } {
  const [models, setModels] = React.useState<ModelInfo[]>(modelCache || []);
  const [loading, setLoading] = React.useState(!modelCache);
  React.useEffect(() => {
    if (modelCache) return;
    if (!modelPromise) {
      modelPromise = studioModels()
        .then((d) => { modelCache = d.models; return d.models; })
        .catch(() => [] as ModelInfo[]).finally(() => { modelPromise = null; });
    }
    modelPromise.then((m) => { setModels(m); setLoading(false); });
  }, []);
  return { models, loading };
}

/**
 * Model aliases the vibe CLI actually accepts for sessions (the app-server's
 * own registry — a different namespace from the Mistral API catalog). Session
 * model pickers must offer these; the API catalog is only a fallback.
 */
let vibeModelCache: ModelInfo[] | null = null;
let vibeModelPromise: Promise<ModelInfo[]> | null = null;
let registryGeneration = 0;
let registryConsumers = 0;

function watchRegistryFocus(): () => void {
  if (registryConsumers++ === 0) window.addEventListener("focus", invalidateVibeModels);
  return () => {
    if (--registryConsumers === 0) window.removeEventListener("focus", invalidateVibeModels);
  };
}

/** Drop the cached vibe model list (call after provider/model changes). */
export function invalidateVibeModels(): void {
  registryGeneration++;
  vibeModelCache = null;
  vibeModelPromise = null;
  agentCache = null;
  agentPromise = null;
  window.dispatchEvent(new Event("vibedeck:models"));
  window.dispatchEvent(new Event("vibedeck:config"));
}

export function useVibeModels(): { models: ModelInfo[]; loading: boolean } {
  const [models, setModels] = React.useState<ModelInfo[]>(vibeModelCache || []);
  const [loading, setLoading] = React.useState(!vibeModelCache);
  React.useEffect(() => {
    let closed = false;
    const load = () => {
      const generation = registryGeneration;
      if (vibeModelCache) { setModels(vibeModelCache); setLoading(false); return; }
      setLoading(true);
      if (!vibeModelPromise) {
        vibeModelPromise = getConfig().then(d => {
          const models = (d.vibeModels || []).map(v => ({ id: v.id, name: v.name, description: "",
            maxContextLength: v.autoCompactThreshold || v.maxContextLength || null, functionCalling: true, vision: v.supportsImages, ownedBy: "" }));
          if (models.length && generation === registryGeneration) vibeModelCache = models;
          return models;
        });
        const pending = vibeModelPromise;
        void pending.finally(() => { if (vibeModelPromise === pending) vibeModelPromise = null; }).catch(() => {});
      }
      vibeModelPromise.then(m => { if (!closed && generation === registryGeneration) setModels(m); }).catch(() => {})
        .finally(() => { if (!closed && generation === registryGeneration) setLoading(false); });
    };
    const unwatchFocus = watchRegistryFocus();
    load();
    window.addEventListener("vibedeck:models", load);
    return () => { closed = true; window.removeEventListener("vibedeck:models", load); unwatchFocus(); };
  }, []);
  return { models, loading };
}

// ---------------------------------------------------------------- ModelPicker — webapp-style chip + dropdown

export function ModelPicker({
  value, onChange, className,
}: {
  value: string; onChange: (v: string) => void; className?: string;
}) {
  // sessions run through the vibe CLI — offer its model aliases, not the
  // (larger) Mistral API catalog; fall back to the catalog if unavailable
  const vibe = useVibeModels();
  const models = vibe.models;
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const { placement, listMaxH } = useDropdownPlacement(open, btnRef, 340, 42);

  // close on Escape, like the webapp
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // the active model is always listed, even if the API catalog lacks it
  const list = React.useMemo(() => {
    const l = [...models];
    if (value && !l.some((m) => m.id === value)) {
      l.unshift({
        id: value, name: value, description: "Current session model",
        maxContextLength: null, functionCalling: true, vision: false, ownedBy: "",
      });
    }
    return l;
  }, [models, value]);

  const needle = q.toLowerCase();
  const filtered = list.filter((m) =>
    !q || m.id.toLowerCase().includes(needle) || modelLabel(m.id, m.name).toLowerCase().includes(needle) ||
    (m.description || "").toLowerCase().includes(needle));
  const current = list.find((m) => m.id === value);
  const currentLabel = modelLabel(value, current?.name);

  return (
    <div className={cn("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Model — ${value}`}
        aria-label="Select model"
        className="flex items-center gap-1 h-7 max-w-[200px] rounded-lg px-2 text-[13px] text-text-muted hover:bg-surface-muted hover:text-text transition-colors"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
        <span className="truncate">{currentLabel}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={cn(
            "absolute left-0 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface-raised shadow-2xl overflow-hidden animate-slide-up",
            placement === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}>
            <div className="flex items-center gap-2 px-3 border-b border-border">
              <Search size={13} className="text-text-faint shrink-0" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search models…"
                className="w-full bg-transparent py-2.5 text-sm text-text placeholder:text-text-faint focus:outline-none"
              />
            </div>
            <div className="overflow-y-auto py-1" style={{ maxHeight: listMaxH }}>
              {filtered.length === 0 && (
                <div className="px-3 py-4 text-xs text-text-faint">No models match.</div>
              )}
              {filtered.map((m) => {
                const active = m.id === value;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => { onChange(m.id); setOpen(false); setQ(""); }}
                    className={cn(
                      "w-full flex items-start gap-2 px-3 py-2 text-left transition-colors",
                      active ? "bg-surface-muted" : "hover:bg-surface-muted/60",
                    )}
                  >
                    <Check size={14} className={cn("mt-0.5 shrink-0", active ? "text-primary" : "opacity-0")} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-text truncate">{modelLabel(m.id, m.name)}</span>
                      <span className="block font-mono text-[11px] text-text-faint truncate mt-0.5">
                        {m.id}{m.description ? ` · ${m.description}` : ""}
                      </span>
                    </span>
                    {m.vision && (
                      <span title="Vision" className="text-[10px] text-info mt-0.5 shrink-0">vision</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- agent list (cached app-wide)

/**
 * Agent profiles known to the vibe CLI: built-in approval modes plus custom
 * profiles (subagent-type fleet workers). Sessions may run as any of them.
 */
let agentCache: AgentInfo[] | null = null;
let agentPromise: Promise<AgentInfo[]> | null = null;

export function useAgents(): { agents: AgentInfo[]; loading: boolean } {
  const [agents, setAgents] = React.useState<AgentInfo[]>(agentCache || []);
  const [loading, setLoading] = React.useState(!agentCache);
  React.useEffect(() => {
    let closed = false;
    const load = () => {
      const generation = registryGeneration;
      if (agentCache) { setAgents(agentCache); setLoading(false); return; }
      setLoading(true);
      if (!agentPromise) {
        agentPromise = getAgents().then(d => d.agents).then(a => {
          if (a.length && generation === registryGeneration) agentCache = a;
          return a;
        });
        const pending = agentPromise;
        void pending.finally(() => { if (agentPromise === pending) agentPromise = null; }).catch(() => {});
      }
      agentPromise.then(a => { if (!closed && generation === registryGeneration) setAgents(a); }).catch(() => {})
        .finally(() => { if (!closed && generation === registryGeneration) setLoading(false); });
    };
    const unwatchFocus = watchRegistryFocus();
    load();
    window.addEventListener("vibedeck:models", load);
    return () => { closed = true; window.removeEventListener("vibedeck:models", load); unwatchFocus(); };
  }, []);
  return { agents, loading };
}

// ---------------------------------------------------------------- AgentPicker — approval posture chip

export const AGENT_MODES: { id: string; label: string; hint: string }[] = [
  { id: "ask", label: "Ask", hint: "Request approval when required by CLI policy" },
  { id: "plan", label: "Plan", hint: "Read and plan before making changes" },
  { id: "accept-edits", label: "Accept edits", hint: "Auto-accept file edits" },
  { id: "auto-approve", label: "Full auto", hint: "Approve all tool actions automatically" },
];

/** Friendly labels for the built-in modes (the app-server's display names are
 *  title-case; "auto-approve" is the vibe CLI's yolo safety level). */
const MODE_LABELS: Record<string, string> = {
  "ask": "Ask",
  "plan": "Plan",
  "accept-edits": "Accept edits",
  "auto-approve": "Full auto",
  "smart-approve": "Smart approve",
};

export function AgentPicker({
  value, onChange, className,
}: {
  value: string; onChange: (v: string) => void; className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const { placement, listMaxH } = useDropdownPlacement(open, btnRef, 320, 34);
  const { agents } = useAgents();

  // close on Escape, like the webapp
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // modes first (approval posture), then subagent profiles (fleet workers)
  const modes = [...new Map([
    ...AGENT_MODES.map(m => [m.id, { name: m.id, displayName: m.label }] as const),
    ...agents.filter(a => a.agentType !== "subagent").map(a => [a.name, { ...a, displayName: MODE_LABELS[a.name] || a.displayName || a.name }] as const),
  ]).values()];
  const subagents = agents.filter((a) => a.agentType === "subagent");

  const mode = AGENT_MODES.find((a) => a.id === value);
  const agent = agents.find((a) => a.name === value);
  const current = agent
    ? { ...agent, displayName: MODE_LABELS[agent.name] || agent.displayName || agent.name }
    : (mode ? { name: mode.id, displayName: mode.label } : { name: value, displayName: value });
  const currentHint = mode?.hint || agent?.description || "";

  const renderRow = (a: { name: string; displayName?: string; description?: string }, sub = false) => {
    const active = a.name === value;
    return (
      <button
        key={a.name}
        type="button"
        aria-label={a.displayName || a.name}
        title={a.description}
        onClick={() => { onChange(a.name); setOpen(false); }}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
          active ? "bg-surface-muted" : "hover:bg-surface-muted/60",
        )}
      >
        <Check size={14} className={cn("shrink-0", active ? "text-primary" : "opacity-0")} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="block text-xs text-text">{a.displayName || a.name}</span>
            {sub && (
              <span className="text-[9px] uppercase tracking-wide rounded px-1 py-0.5 bg-primary/15 text-primary shrink-0">
                subagent
              </span>
            )}
          </span>
          {a.description && (
            <span className="block text-[11px] text-text-faint truncate">{a.description}</span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className={cn("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Agent — ${currentHint || value}`}
        aria-label="Select agent"
        className="flex items-center gap-1 h-7 rounded-lg px-2 text-[13px] text-text-muted hover:bg-surface-muted hover:text-text transition-colors"
      >
        <span className="hidden sm:inline">{current.displayName || value}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className={cn(
            "absolute left-0 z-50 w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface-raised shadow-2xl overflow-hidden animate-slide-up",
            placement === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}>
            <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-text-faint border-b border-border">
              Agent
            </div>
            <div className="overflow-y-auto py-1" style={{ maxHeight: listMaxH }}>
              {modes.map((a) => renderRow(a))}
              {subagents.length > 0 && (
                <>
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-text-faint border-t border-border mt-1">
                    Subagents
                  </div>
                  {subagents.map((a) => <div key={a.name} className="px-3 py-2 text-xs text-text-muted" title={a.description}>
                    {a.displayName || a.name}<span className="block text-[11px] text-text-faint">Ask in the conversation to delegate</span>
                  </div>)}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
