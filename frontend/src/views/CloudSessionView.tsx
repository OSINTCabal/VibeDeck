import * as React from "react";
import { useParams } from "react-router-dom";
import { ArrowUp, Cloud, CloudOff, ExternalLink, Loader2, RotateCw, Square } from "lucide-react";
import { EntryBlock, StepGroup } from "@/components/MessageBlocks";
import { Button } from "@/components/ui";
import { groupSteps } from "@/lib/steps";
import {
  CloudFailure, cloudCallbackResult, interruptCloud, loadCloudMessages, loadCloudState, respondCloudCallback,
  sendCloudMessage, signInToCloud, useCloud,
} from "@/lib/cloud";
import type { CloudSessionState, HistoryEntry } from "@/lib/types";

const PAGE = 60;
const WEB = "https://chat.mistral.ai/code";
const POLL_MS = 3000;

/** A Vibe Code Web session: its conversation, and a reply box that continues it in the cloud. */
export function CloudSessionView() {
  const { projectId = "", sessionId = "" } = useParams();
  const cloud = useCloud();
  const session = cloud.sessions.find(s => s.id === sessionId);
  const project = cloud.projects.find(p => p.id === projectId);
  const url = session?.url || `${WEB}/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}`;
  const [entries, setEntries] = React.useState<HistoryEntry[] | null>(null);
  const [live, setLive] = React.useState<CloudSessionState | null>(null);
  const [error, setError] = React.useState<CloudFailure | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [shown, setShown] = React.useState(PAGE);
  // A sent prompt stays on screen until the transcript includes it.
  const [pending, setPending] = React.useState<{ text: string; key: string; failed?: string } | null>(null);
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [awaiting, setAwaiting] = React.useState(false);
  const request = React.useRef(0);
  // After a send or an answer, keep following until the turn has run and ended.
  const turn = React.useRef<{ since: number; seenActive: boolean } | null>(null);
  const expectTurn = () => { turn.current = { since: Date.now(), seenActive: false }; setAwaiting(true); };

  const load = React.useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const [next, state] = await Promise.all([loadCloudMessages(sessionId), loadCloudState(sessionId).catch(() => null)]);
      if (id !== request.current) return;
      setEntries(next);
      setLive(state);
      setError(null);
      setPending(p => p && !p.failed && next.some(e => e.role === "user" && entryText(e) === p.text.trim()) ? null : p);
      const watch = turn.current;
      if (watch && state?.active) watch.seenActive = true;
      if (watch && state && !state.active && (watch.seenActive || Date.now() - watch.since > 30000)) {
        turn.current = null;
        setAwaiting(false);
      }
    } catch (e) {
      if (id === request.current) setError(e instanceof CloudFailure ? e : new CloudFailure("unavailable", String(e)));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [sessionId]);

  React.useEffect(() => {
    setEntries(null); setLive(null); setError(null); setShown(PAGE);
    setPending(null); setText(""); setAwaiting(false); turn.current = null;
    void load();
  }, [load]);

  // Follow a running turn; otherwise catch up when the window regains focus.
  const running = !!live?.active || awaiting;
  React.useEffect(() => {
    if (running) {
      const timer = window.setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
      return () => window.clearInterval(timer);
    }
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [running, load]);

  const shownEntries = React.useMemo(() => {
    const list = entries || [];
    if (!pending) return list;
    return [...list, { id: "pending:" + pending.key, sessionId, turnId: "pending", type: "message", role: "user",
      content: [{ type: "text", text: pending.text }], createdAt: Date.now(), updatedAt: Date.now() } as HistoryEntry];
  }, [entries, pending, sessionId]);
  const steps = React.useMemo(() => groupSteps(shownEntries), [shownEntries]);
  const hidden = Math.max(0, steps.length - shown);
  const visibleSteps = hidden ? steps.slice(hidden) : steps;

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shownEntries, running]);

  const send = async () => {
    const prompt = (pending?.failed ? pending.text : text).trim();
    if (!prompt || sending || running) return;
    const key = pending?.failed ? pending.key : crypto.randomUUID();
    setSending(true);
    setPending({ text: prompt, key });
    setText("");
    pinned.current = true;
    try {
      await sendCloudMessage(sessionId, prompt, key);
      expectTurn();
      void load();
    } catch (e) {
      setPending({ text: prompt, key, failed: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    try { await interruptCloud(sessionId); turn.current = null; setAwaiting(false); await load(); }
    catch (e) { setError(e instanceof CloudFailure ? e : new CloudFailure("unavailable", String(e))); }
    finally { setStopping(false); }
  };

  const onResolve = React.useCallback(async (callbackId: string, decision: string, userInput?: unknown) => {
    const entry = (entries || []).find(e => e.callbackId === callbackId);
    if (!entry) throw new Error("This request is no longer open.");
    await respondCloudCallback(sessionId, callbackId, cloudCallbackResult(entry, decision, userInput));
    expectTurn();
    await load();
  }, [entries, sessionId, load]);

  const canReply = !!window.vibedeck?.cloud?.write && !!entries && !error;
  const waiting = live?.waitKind === "question" || live?.waitKind === "approval";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-1 pl-5 pr-3 shrink-0">
        <div className="min-w-0 flex-1 flex items-center gap-2 text-sm">
          <span className="hidden min-w-0 shrink items-center gap-1.5 text-text-muted sm:flex" title="Vibe Code Web project">
            <Cloud size={16} className="shrink-0" />
            <span className="truncate">{project?.name || "Vibe Code Web"}</span>
          </span>
          <span className="hidden shrink-0 text-text-faint sm:inline">/</span>
          <span className="min-w-0 truncate text-text">{live?.title || session?.title || "Cloud session"}</span>
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

      <div ref={scrollRef} onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
        className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl min-h-full flex flex-col gap-1 pt-4 pb-6">
          {hidden > 0 && <button onClick={() => setShown(n => n + PAGE)} className="mx-auto my-3 rounded-md px-2.5 py-1 text-sm text-text-muted transition-colors hover:bg-surface-muted hover:text-text">Show {Math.min(hidden, PAGE)} earlier steps</button>}
          {loading && !entries && (
            <div className="my-auto flex items-center gap-2 px-6 py-8 text-text-muted text-sm">
              <Loader2 size={14} className="animate-spin text-primary" /> Loading conversation from Vibe Code Web…
            </div>
          )}
          {error && !entries && <CloudProblem error={error} retry={load} url={url} />}
          {entries && shownEntries.length === 0 && <div className="my-auto px-6 py-10 text-text-muted text-sm">This cloud session has no messages yet.</div>}
          {visibleSteps.map(item => item.kind === "group"
            ? <StepGroup key={item.entries[0].id} entries={item.entries} />
            : <EntryBlock key={item.entry.id} e={item.entry} onResolve={onResolve} reveal={item.entry.id.startsWith("pending:")} />)}
          {pending?.failed && <p role="alert" className="px-6 text-right text-xs text-danger">Not sent: {pending.failed}</p>}
          {running && (
            <div className="px-6 py-2 flex items-center gap-2 text-sm font-medium text-text-muted">
              <span className="vd-dots text-primary"><span /><span /><span /></span>
              <span className="vd-shimmer">Vibe is working in the cloud…</span>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-5 pt-2">
        <div className="mx-auto max-w-3xl">
          {error && entries && <p role="alert" className="mb-2 text-xs text-danger">{error.message}</p>}
          {canReply ? (
            <div className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.12),0_6px_16px_-6px_rgb(0_0_0/0.2)] transition-colors duration-150 focus-within:border-border-strong">
              <textarea
                aria-label="Reply to this cloud session"
                value={pending?.failed ? pending.text : text}
                onChange={event => { setPending(p => p?.failed ? null : p); setText(event.target.value); }}
                onKeyDown={event => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
                }}
                placeholder={running ? "Vibe is working…" : waiting ? "Answer above, or reply to Vibe…" : "Reply to continue on Vibe Code Web…"}
                rows={1}
                disabled={sending}
                className="w-full bg-transparent px-4 pt-4 pb-0 text-base leading-6 text-text placeholder:text-text-muted resize-none focus:outline-none max-h-48"
                style={{ minHeight: 40 }}
              />
              <div className="flex items-center gap-2 px-3 pt-3 pb-3">
                <span className="flex min-w-0 items-center gap-1.5 pl-1 text-xs text-text-faint">
                  <Cloud size={14} className="shrink-0" /><span className="truncate">Runs on Vibe Code Web</span>
                </span>
                <div className="flex-1" />
                {running ? (
                  <button type="button" onClick={() => void stop()} disabled={stopping} title="Stop the cloud turn" aria-label="Stop"
                    className="h-8 w-8 shrink-0 grid place-items-center rounded-md vd-send disabled:opacity-40">
                    {stopping ? <Loader2 size={16} className="animate-spin" /> : <Square size={12} fill="currentColor" />}
                  </button>
                ) : (
                  <button type="button" onClick={() => void send()} title="Send (Enter)" aria-label="Send"
                    disabled={sending || !(pending?.failed ? pending.text : text).trim()}
                    className="h-8 w-8 shrink-0 grid place-items-center rounded-md vd-send disabled:opacity-40 disabled:pointer-events-none">
                    {sending ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2} />}
                  </button>
                )}
              </div>
            </div>
          ) : entries && (
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-text-muted">
              <Cloud size={16} className="shrink-0" />
              <span className="min-w-0 flex-1">This session runs on Vibe Code Web. Continue it on chat.mistral.ai.</span>
              <a href={url} target="_blank" rel="noreferrer"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover active:bg-primary-press">
                Continue on web<ExternalLink size={14} />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function entryText(e: HistoryEntry): string {
  return (e.content || []).filter(c => c.type === "text").map(c => c.text || "").join("\n\n").trim();
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
