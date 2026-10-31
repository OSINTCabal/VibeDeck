import * as React from "react";
import { Bot, Brain, ChevronDown, Eye, FilePen, Hand, ListChecks, Search, Sparkles, Zap } from "lucide-react";
import { ModelIcon } from "./ModelIcon";
import { RadioMark, menuItem, menuLabel, menuPanel, usePresence } from "./ui";
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

/** Composer toolbar chip: 32px, 8px radius, like the webapp's model chip. */
export const chipClass = "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-text-muted transition-colors duration-75 ease-out hover:bg-surface-muted hover:text-text";

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
            maxContextLength: v.autoCompactThreshold || v.maxContextLength || null, functionCalling: true, vision: v.supportsImages, ownedBy: "",
            thinkingLevels: v.thinkingLevels || [], defaultThinking: v.thinking || null }));
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
  const { placement, listMaxH } = useDropdownPlacement(open, btnRef, 340, 52);
  const presence = usePresence(open);

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
        aria-expanded={open}
        className={cn(chipClass, "max-w-[200px] gap-2 bg-surface-muted text-text hover:bg-surface-muted/70")}
      >
        <ModelIcon id={value} size={16} />
        <span className="hidden truncate sm:inline">{currentLabel}</span>
      </button>
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      {presence.mounted && (
        <div
          data-side={placement === "up" ? "top" : "bottom"}
          data-state={presence.state}
          role="menu"
          className={cn(
            menuPanel, "absolute right-0 z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden",
            placement === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          <div className="flex items-center gap-2 rounded-sm px-3">
            <Search size={16} className="text-text-faint shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search models…"
              className="w-full bg-transparent py-2 text-sm text-text placeholder:text-text-faint focus:outline-none"
            />
          </div>
          <div className="my-1 h-px bg-border" />
          <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-1 overflow-y-auto overflow-x-hidden" style={{ maxHeight: listMaxH }}>
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-sm text-text-faint">No models match.</div>
            )}
            {filtered.map((m) => {
              const active = m.id === value;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  aria-label={`${modelLabel(m.id, m.name)} (${m.id})`}
                  title={m.id}
                  onClick={() => { onChange(m.id); setOpen(false); setQ(""); }}
                  className={cn(menuItem, "py-3")}
                >
                  <ModelIcon id={m.id} size={16} className="self-start mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{modelLabel(m.id, m.name)}</span>
                    {m.description && <span className="block truncate text-xs text-text-muted mt-0.5">{m.description}</span>}
                  </span>
                  {m.vision && (
                    <span title="Understands images" aria-label="Understands images" className="shrink-0 text-text-faint">
                      <Eye size={14} />
                    </span>
                  )}
                  <RadioMark checked={active} className="ml-1" />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- EffortPicker — reasoning level for the model

const EFFORT_LABELS: Record<string, string> = { off: "Off", low: "Low", medium: "Medium", high: "High", max: "Max" };
const effortLabel = (level: string) => EFFORT_LABELS[level] || level.charAt(0).toUpperCase() + level.slice(1);

/**
 * Reasoning effort chip. Offers the levels the vibe CLI registry lists for
 * the selected model; "Default" leaves the model's own setting in place.
 * Hidden for models without reasoning levels.
 */
export function EffortPicker({
  model, value, onChange, className,
}: {
  model: string; value: string | null; onChange: (v: string | null) => void; className?: string;
}) {
  const { models } = useVibeModels();
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const info = models.find(m => m.id === model);
  // Vibe 3.0.4+ lets a model list levels of its own ("turbo", "minimal"…)
  const levels = (info?.thinkingLevels || []).filter(l => /^[a-z][a-z0-9_-]{0,31}$/.test(l));
  const { placement } = useDropdownPlacement(open, btnRef, 220);
  const presence = usePresence(open);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!levels.length) return null;
  const fallback = info?.defaultThinking ? `Default (${effortLabel(info.defaultThinking)})` : "Default";
  const options: { id: string | null; label: string }[] = [{ id: null, label: fallback }, ...levels.map(l => ({ id: l, label: effortLabel(l) }))];
  const current = value && levels.includes(value) ? effortLabel(value) : info?.defaultThinking ? effortLabel(info.defaultThinking) : "Auto";

  return (
    <div className={cn("relative", className)}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        title={`Reasoning effort — ${current}`}
        aria-label="Select reasoning effort"
        aria-expanded={open}
        className={chipClass}
      >
        <Brain size={16} className="shrink-0" />
        <span className="hidden sm:inline">{current}</span>
        <ChevronDown size={14} className="shrink-0 opacity-60" />
      </button>
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      {presence.mounted && (
        <div
          data-side={placement === "up" ? "top" : "bottom"}
          data-state={presence.state}
          role="menu"
          className={cn(
            menuPanel, "absolute right-0 z-50 w-56",
            placement === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          <div className={menuLabel}>Reasoning effort</div>
          <div className="flex flex-col gap-1">
            {options.map(o => {
              const active = (o.id ?? null) === (value && levels.includes(value) ? value : null);
              return (
                <button key={o.id ?? "default"} type="button" role="menuitemradio" aria-checked={active}
                  onClick={() => { onChange(o.id); setOpen(false); }}
                  className={menuItem}>
                  <span className="flex-1">{o.label}</span>
                  <RadioMark checked={active} />
                </button>
              );
            })}
          </div>
        </div>
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

/** Icon per approval posture, so the chip still reads when its label is hidden. */
const MODE_ICONS: Record<string, React.ElementType> = {
  "ask": Hand, "plan": ListChecks, "accept-edits": FilePen, "auto-approve": Zap, "smart-approve": Sparkles,
};

export function AgentPicker({
  value, onChange, className,
}: {
  value: string; onChange: (v: string) => void; className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const { placement, listMaxH } = useDropdownPlacement(open, btnRef, 320, 34);
  const presence = usePresence(open);
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
  const ModeIcon = MODE_ICONS[value] || Bot;

  const renderRow = (a: { name: string; displayName?: string; description?: string }) => {
    const active = a.name === value;
    return (
      <button
        key={a.name}
        type="button"
        role="menuitemradio"
        aria-checked={active}
        aria-label={a.displayName || a.name}
        title={a.description}
        onClick={() => { onChange(a.name); setOpen(false); }}
        className={cn(menuItem, "items-start py-2.5")}
      >
        <span className="min-w-0 flex-1">
          <span className="block">{a.displayName || a.name}</span>
          {a.description && (
            <span className="block line-clamp-2 text-xs text-text-muted mt-0.5">{a.description}</span>
          )}
        </span>
        <RadioMark checked={active} className="mt-0.5" />
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
        aria-expanded={open}
        className={chipClass}
      >
        <ModeIcon size={16} className="shrink-0" />
        <span className="hidden sm:inline">{current.displayName || value}</span>
        <ChevronDown size={14} className="shrink-0 opacity-60" />
      </button>
      {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
      {presence.mounted && (
        <div
          data-side={placement === "up" ? "top" : "bottom"}
          data-state={presence.state}
          role="menu"
          className={cn(
            menuPanel, "absolute left-0 z-50 w-64 max-w-[calc(100vw-2rem)]",
            placement === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          <div className={menuLabel}>Mode</div>
          <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-1 overflow-y-auto overflow-x-hidden" style={{ maxHeight: listMaxH }}>
            {modes.map((a) => renderRow(a))}
            {subagents.length > 0 && (
              <>
                <div className="mx-1 my-1 h-px bg-border" />
                <div className={menuLabel}>Subagents</div>
                {subagents.map((a) => <div key={a.name} className="px-3 py-2 text-sm text-text-muted" title={a.description}>
                  {a.displayName || a.name}<span className="block text-xs text-text-faint mt-0.5">Ask in the conversation to delegate</span>
                </div>)}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
