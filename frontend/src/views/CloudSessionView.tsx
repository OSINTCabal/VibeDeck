import * as React from "react";
import { useParams } from "react-router-dom";
import { Cloud, CloudOff, ExternalLink, Loader2, RotateCw } from "lucide-react";
import { EntryBlock, StepGroup } from "@/components/MessageBlocks";
import { Button } from "@/components/ui";
import { groupSteps } from "@/lib/steps";
import { CloudFailure, loadCloudMessages, signInToCloud, useCloud } from "@/lib/cloud";
import type { HistoryEntry } from "@/lib/types";

const PAGE = 60;
const WEB = "https://chat.mistral.ai/code";
const readOnly = async () => {};

/** A Vibe Code Web session, read-only; it continues on chat.mistral.ai. */
export function CloudSessionView() {
  const { projectId = "", sessionId = "" } = useParams();
  const cloud = useCloud();
  const session = cloud.sessions.find(s => s.id === sessionId);
  const project = cloud.projects.find(p => p.id === projectId);
  const url = session?.url || `${WEB}/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`;
  const [entries, setEntries] = React.useState<HistoryEntry[] | null>(null);
  const [error, setError] = React.useState<CloudFailure | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [shown, setShown] = React.useState(PAGE);
  const request = React.useRef(0);

  const load = React.useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const next = await loadCloudMessages(sessionId);
      if (id === request.current) { setEntries(next); setError(null); }
    } catch (e) {
      if (id === request.current) setError(e instanceof CloudFailure ? e : new CloudFailure("unavailable", String(e)));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [sessionId]);

  React.useEffect(() => {
    setEntries(null);
    setError(null);
    setShown(PAGE);
    void load();
  }, [load]);

  const steps = React.useMemo(() => groupSteps(entries || []), [entries]);
  const hidden = Math.max(0, steps.length - shown);
  const visibleSteps = hidden ? steps.slice(hidden) : steps;
  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && entries && shown === PAGE) el.scrollTop = el.scrollHeight;
  }, [entries, shown]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-1 pl-5 pr-3 shrink-0">
        <div className="min-w-0 flex-1 flex items-center gap-2 text-sm">
          <span className="hidden min-w-0 shrink items-center gap-1.5 text-text-muted sm:flex" title="Vibe Code Web project">
            <Cloud size={16} className="shrink-0" />
            <span className="truncate">{project?.name || "Vibe Code Web"}</span>
          </span>
          <span className="hidden shrink-0 text-text-faint sm:inline">/</span>
          <span className="min-w-0 truncate text-text">{session?.title || "Cloud session"}</span>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} title="Refresh conversation" aria-label="Refresh conversation"
          className="shrink-0 grid h-8 w-8 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text disabled:opacity-40 disabled:hover:bg-transparent">
          <RotateCw size={16} className={loading && entries ? "animate-spin" : undefined} />
        </button>
        <a href={url} target="_blank" rel="noreferrer"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-text-muted transition-colors hover:bg-surface-muted hover:text-text">
          Open on chat.mistral.ai<ExternalLink size={14} />
        </a>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl min-h-full flex flex-col gap-1 pt-4 pb-6">
          {hidden > 0 && <button onClick={() => setShown(n => n + PAGE)} className="mx-auto my-3 rounded-md px-2.5 py-1 text-sm text-text-muted transition-colors hover:bg-surface-muted hover:text-text">Show {Math.min(hidden, PAGE)} earlier steps</button>}
          {loading && !entries && (
            <div className="my-auto flex items-center gap-2 px-6 py-8 text-text-muted text-sm">
              <Loader2 size={14} className="animate-spin text-primary" /> Loading conversation from Vibe Code Web…
            </div>
          )}
          {error && !entries && <CloudProblem error={error} retry={load} url={url} />}
          {entries && entries.length === 0 && <div className="my-auto px-6 py-10 text-text-muted text-sm">This cloud session has no messages yet.</div>}
          {visibleSteps.map(item => item.kind === "group"
            ? <StepGroup key={item.entries[0].id} entries={item.entries} />
            : <EntryBlock key={item.entry.id} e={item.entry} onResolve={readOnly} reveal={false} />)}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-5 pt-2">
        <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-text-muted">
          <Cloud size={16} className="shrink-0" />
          <span className="min-w-0 flex-1">
            {error && entries ? error.message : "This session runs on Vibe Code Web. VibeDeck shows it read-only; continue it on chat.mistral.ai."}
          </span>
          <a href={url} target="_blank" rel="noreferrer"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover active:bg-primary-press">
            Continue on web<ExternalLink size={14} />
          </a>
        </div>
      </div>
    </div>
  );
}

function CloudProblem({ error, retry, url }: { error: CloudFailure; retry: () => Promise<void>; url: string }) {
  const [busy, setBusy] = React.useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } finally { setBusy(false); }
  };
  const Icon = error.code === "offline" ? CloudOff : Cloud;
  return (
    <div role="status" className="my-auto flex flex-col items-center gap-3 px-6 py-10 text-center">
      <Icon size={20} className="text-text-faint" />
      <p className="max-w-sm text-sm text-text-muted">{error.message}</p>
      <div className="flex gap-2">
        {error.code === "signed_out"
          ? <Button variant="primary" size="sm" disabled={busy} onClick={() => void run(async () => { await signInToCloud(); await retry(); })}>Sign in to Mistral</Button>
          : error.code === "blocked"
            ? <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-surface-muted px-3 text-sm font-medium text-text hover:bg-surface-muted/70">Open on chat.mistral.ai<ExternalLink size={14} /></a>
            : <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(retry)}>Try again</Button>}
      </div>
    </div>
  );
}
