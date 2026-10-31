import * as React from "react";
import { Activity, Bot, ChevronRight, Loader2, Square, Terminal, X } from "lucide-react";
import { cn, formatTokens, modelLabel } from "@/lib/utils";
import {
  getBackground, getBackgroundOutput, getSubagents, interruptSubagents, stopBackground,
  type BackgroundProcess, type SubagentRun,
} from "@/lib/api";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const LIVE = new Set(["running"]);
const dot = (status: string) => cn("h-1.5 w-1.5 shrink-0 rounded-full",
  status === "running" ? "bg-primary animate-blink" : status === "failed" ? "bg-danger"
    : status === "interrupted" || status === "stopped" || status === "orphaned" ? "bg-accent" : "bg-success");

/**
 * What runs alongside the conversation: the subagents the model spawned and
 * the background processes the agent started, with their output. Refreshes
 * while open, faster while something runs.
 */
export function ActivityPanel({ sessionId, running, refreshKey, onClose }: {
  sessionId: string; running: boolean; refreshKey: unknown; onClose: () => void;
}) {
  const [agents, setAgents] = React.useState<SubagentRun[] | null>(null);
  const [procs, setProcs] = React.useState<BackgroundProcess[] | null>(null);
  const [showDone, setShowDone] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    getSubagents(sessionId).then(d => setAgents(d.subagents)).catch(() => setAgents(a => a ?? []));
    getBackground(sessionId).then(d => setProcs(d.processes)).catch(() => setProcs(p => p ?? []));
  }, [sessionId]);
  React.useEffect(load, [load, refreshKey]);
  const live = running || (agents || []).some(a => LIVE.has(a.status)) || (procs || []).some(p => LIVE.has(p.status));
  React.useEffect(() => {
    const timer = setInterval(load, live ? 3000 : 15000);
    return () => clearInterval(timer);
  }, [load, live]);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); load(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };

  // like Vibe 3.0.4: finished subagents fold away behind one row
  const active = (agents || []).filter(a => LIVE.has(a.status));
  const done = (agents || []).filter(a => !LIVE.has(a.status));

  return (
    <aside aria-label="Activity" className={cn(
      "flex h-full w-[min(480px,44%)] min-w-[300px] shrink-0 flex-col border-l border-border bg-bg",
      "max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(480px,92%)] max-lg:shadow-2xl",
    )}>
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <Activity size={16} className="text-text-muted" />
        <span className="text-sm font-medium">Activity</span>
        <div className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Close activity"
          className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text">
          <X size={15} />
        </button>
      </div>
      {error && <p role="alert" className="shrink-0 px-3 pb-2 text-xs text-danger">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <Section title="Subagents" count={agents?.length} action={active.length > 0 && (
          <button type="button" disabled={busy} onClick={() => void act(() => interruptSubagents(sessionId))}
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40">
            <Square size={10} fill="currentColor" /> Stop all
          </button>
        )}>
          {agents === null ? <Loading /> : agents.length === 0 ? <Empty text="The model has not spawned subagents in this session." /> : (
            <>
              {active.map(a => <AgentRow key={a.sessionId} a={a} />)}
              {done.length > 0 && (
                <button type="button" onClick={() => setShowDone(v => !v)} aria-expanded={showDone}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-text-muted hover:bg-surface-muted/50">
                  <ChevronRight size={12} className={cn("transition-transform", showDone && "rotate-90")} />
                  {done.length} subagent{done.length === 1 ? "" : "s"} finished
                </button>
              )}
              {showDone && done.map(a => <AgentRow key={a.sessionId} a={a} />)}
            </>
          )}
        </Section>
        <Section title="Background processes" count={procs?.length}>
          {procs === null ? <Loading /> : procs.length === 0 ? <Empty text="No background processes. Dev servers and watchers the agent starts appear here." />
            : procs.map(p => (
              <ProcessRow key={p.processId} sessionId={sessionId} p={p} busy={busy}
                onStop={() => void act(() => stopBackground(sessionId, p.processId))} />
            ))}
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="pt-3">
      <div className="flex items-center gap-2 px-3 pb-1.5">
        <h3 className="text-xs font-medium text-text-muted">{title}</h3>
        {!!count && <span className="text-[11px] text-text-faint">{count}</span>}
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

const Loading = () => <p className="flex items-center gap-2 px-3 py-2 text-xs text-text-muted"><Loader2 size={12} className="animate-spin" /> Loading…</p>;
const Empty = ({ text }: { text: string }) => <p className="px-3 py-2 text-xs text-text-faint">{text}</p>;

function AgentRow({ a }: { a: SubagentRun }) {
  const tokens = a.usage?.totalTokens || 0;
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
      <Bot size={14} className={cn("shrink-0", a.status === "running" ? "text-primary" : "text-text-faint")} />
      <span className="min-w-0 flex-1 truncate text-text" title={a.agentType || undefined}>{a.name}</span>
      {a.model && <span className="hidden truncate text-[11px] text-text-faint sm:inline">{modelLabel(a.model)}</span>}
      {tokens > 0 && <span className="shrink-0 font-mono text-[11px] text-text-faint">{formatTokens(tokens)}</span>}
      {a.costUsd != null && a.costUsd > 0 && <span className="shrink-0 font-mono text-[11px] text-text-faint">${a.costUsd.toFixed(3)}</span>}
      <span className={dot(a.status)} />
      <span className="w-16 shrink-0 text-[11px] text-text-faint">{a.status}</span>
    </div>
  );
}

function ProcessRow({ sessionId, p, busy, onStop }: { sessionId: string; p: BackgroundProcess; busy: boolean; onStop: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [out, setOut] = React.useState<{ text: string; truncated: boolean } | null>(null);
  const runningNow = p.status === "running";
  const ref = React.useRef<HTMLPreElement>(null);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    const read = () => getBackgroundOutput(sessionId, p.processId)
      .then(d => { if (live) setOut(d.available ? { text: d.text || "", truncated: !!d.truncatedBefore } : { text: "Output is no longer available.", truncated: false }); })
      .catch(() => {});
    void read();
    const timer = runningNow ? setInterval(read, 1500) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [open, sessionId, p.processId, runningNow]);
  React.useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [out]);

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 text-left hover:bg-surface-muted/50">
          <ChevronRight size={12} className={cn("shrink-0 text-text-faint transition-transform", open && "rotate-90")} />
          <Terminal size={13} className="shrink-0 text-text-muted" />
          <span className="min-w-0 truncate font-mono text-xs text-text" title={p.command}>{p.command}</span>
        </button>
        <span className={dot(p.status)} />
        <span className="shrink-0 text-[11px] text-text-faint">{p.status}{p.exitCode != null ? ` · ${p.exitCode}` : ""}</span>
        {runningNow && (
          <button type="button" disabled={busy} onClick={onStop} title="Stop process" aria-label={`Stop ${p.command}`}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40">
            <Square size={10} fill="currentColor" />
          </button>
        )}
      </div>
      {open && (
        <pre ref={ref} className="mx-3 mb-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-code p-2 font-mono text-[11px] leading-4 text-text-muted">
          {out === null ? "Loading output…" : `${out.truncated ? "…\n" : ""}${out.text || "(no output yet)"}`}
        </pre>
      )}
    </div>
  );
}
