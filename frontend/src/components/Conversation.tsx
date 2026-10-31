import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Activity as ActivityIcon, AlertTriangle, ArrowDown, Bot, ChevronDown, Cloud, Copy, FileDiff, Folder, FolderTree, GitFork, Loader2, Pencil, Terminal, Trash2, X } from "lucide-react";
import { cn, formatTokens } from "@/lib/utils";
import { Composer, type ImageAttachment } from "./Composer";
import { CloudDialog } from "./CloudDialog";
import { BranchPicker } from "./BranchPicker";
import { ActivityPanel } from "./ActivityPanel";
import { QueueBar } from "./QueueBar";
import { ReviewPanel, pendingFiles } from "./ReviewPanel";
import { RewindDialog } from "./RewindDialog";
import { EntryBlock, MessageActions, StepGroup } from "./MessageBlocks";
import { groupSteps } from "@/lib/steps";
import { useConversation } from "@/hooks/useConversation";
import { sendTurn, enqueueTurn, forkSession, compactSession, runShell, interruptTurn, resolveCallback, patchSession, releaseSession, deleteSession, getReview, type ReviewState } from "@/lib/api";
import { SessionMenu } from "./SessionMenu";
import { ensureNotificationPermission, notify } from "@/lib/notifications";
import type { ChildSession, Session } from "@/lib/types";

const PAGE = 60;

export function Conversation({ session }: { session: Session }) {
  const [released, setReleased] = React.useState(false);
  const conv = useConversation(session.id, released);
  const sendingRef = React.useRef(false);
  const requestRef = React.useRef<{ payload: string; id: string } | null>(null);
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [handoff, setHandoff] = React.useState<string | null>(null);
  const [cloudOpen, setCloudOpen] = React.useState(false);
  const [warnings, setWarnings] = React.useState<string[]>(session.warnings ?? []);
  const [model, setModel] = React.useState(session.model || "");
  const [agent, setAgent] = React.useState(session.agent || "");
  React.useEffect(() => { setModel(session.model || ""); setAgent(session.agent || ""); }, [session.model, session.agent]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = React.useState(true);
  const pinned = React.useRef(true);

  React.useEffect(() => {
    if (conv.session?.model) setModel(conv.session.model);
    const acceptedAgent = conv.session?.agent;
    if (acceptedAgent) setAgent(typeof acceptedAgent === "string" ? acceptedAgent : acceptedAgent.name);
  }, [conv.session?.model, conv.session?.agent]);
  const running = conv.turnStatus === "running";

  // pending file changes from Vibe's checkpoints; null until loaded, and the
  // review stays hidden if this Vibe has no review support
  const [review, setReview] = React.useState<ReviewState | null>(null);
  const [reviewSupported, setReviewSupported] = React.useState(true);
  // one side panel at a time: the agent's file changes, or what runs alongside
  const [panel, setPanel] = React.useState<"changes" | "activity" | null>(null);
  const reviewOpen = panel === "changes";
  const togglePanel = (p: "changes" | "activity") => setPanel(cur => (cur === p ? null : p));
  const loadReview = React.useCallback(() => {
    getReview(session.id).then(r => { setReview(r); setReviewSupported(true); })
      .catch(e => { if (/not found|-32601/i.test(String(e))) setReviewSupported(false); });
  }, [session.id]);
  React.useEffect(() => { setReview(null); if (!released) loadReview(); }, [loadReview, released]);
  React.useEffect(() => { if (conv.turnStatus === "completed") loadReview(); }, [conv.turnStatus, loadReview]);
  React.useEffect(() => {
    if (!reviewOpen || !running) return;
    const timer = setInterval(loadReview, 4000);
    return () => clearInterval(timer);
  }, [reviewOpen, running, loadReview]);
  const changedFiles = pendingFiles(review).length;
  const childList = Object.values(conv.childSessions);
  const liveAgents = childList.filter(childRunning).length;
  const finishedAgents = childList.length - liveAgents;
  // "!command": the output streams into the conversation as a shell entry
  const shellCommand = async (command: string) => {
    setSendError(null);
    await runShell(session.id, command);
  };
  // the compacted history arrives on the event stream as a fresh snapshot
  const compact = async () => { await compactSession(session.id); };
  const [rewindEntry, setRewindEntry] = React.useState<string | null>(null);

  // auto-scroll to bottom on new content — only when the user is already near
  // the bottom (don't yank the view while reading history), and jump instantly
  // so streaming text doesn't fight a smooth-scroll animation
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
  }, [conv.entries, conv.turnStatus]);

  const send = async (t: string, images: ImageAttachment[]) => {
    const text = t.trim();
    if (!text && images.length === 0) return;
    if (sendingRef.current || released) return;
    sendingRef.current = true;
    setText("");
    setSendError(null);
    setSending(true);
    ensureNotificationPermission(); // user gesture — safe moment to ask
    try {
      const payload = JSON.stringify([text, images]);
      if (requestRef.current?.payload !== payload) requestRef.current = { payload, id: crypto.randomUUID() };
      // while the agent works, the message waits in Vibe's turn queue
      if (running) await enqueueTurn(session.id, text, images, requestRef.current.id);
      else await sendTurn(session.id, text, images, requestRef.current.id);
      requestRef.current = null;
    } catch (e) {
      setText(t);
      setSendError(`Failed to send: ${e}`);
      throw e;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  // desktop notifications: turn finished / approval needed while unfocused
  const prevTurn = React.useRef(conv.turnStatus);
  React.useEffect(() => {
    const prev = prevTurn.current;
    prevTurn.current = conv.turnStatus;
    if (prev === "running" && conv.turnStatus === "completed" && !document.hasFocus()) {
      notify("Vibe finished", session.title);
    }
  }, [conv.turnStatus, session.title]);

  const prevCallbacks = React.useRef(conv.pendingCallbacks.length);
  React.useEffect(() => {
    const prev = prevCallbacks.current;
    prevCallbacks.current = conv.pendingCallbacks.length;
    if (conv.pendingCallbacks.length > 0 && prev === 0 && !document.hasFocus()) {
      notify("Vibe needs your approval", session.title);
    }
  }, [conv.pendingCallbacks.length, session.title]);

  const stop = async () => {
    if (!conv.activeTurnId) return;
    try {
      await interruptTurn(session.id, conv.activeTurnId);
    } catch (e) { setSendError(`Could not stop turn: ${e}`); }
  };

  const onResolve = React.useCallback(async (callbackId: string, decision: string, userInput?: unknown) => {
    try {
      await resolveCallback(session.id, callbackId, decision, undefined, userInput);
    } catch (e) {
      setSendError(`Failed to ${decision}: ${e}`);
      throw e;
    }
  }, [session.id]);

  // hand the session back to the vibe CLI: release the desktop lease and
  // copy the resume command so the user can paste it in a terminal
  const handoffToCli = async () => {
    conv.disconnect();
    setReleased(true);
    let cmd = `vibe --resume ${session.id}`;
    try {
      const result = await releaseSession(session.id);
      cmd = `vibe --resume ${result.resumeId || session.id}`;
    } catch (e) {
      setReleased(false);
      setSendError(`Could not hand off: ${e}`);
      return;
    }
    try {
      await navigator.clipboard.writeText(cmd);
      setHandoff(`Released — run ${cmd} in your terminal (copied to clipboard)`);
    } catch {
      setHandoff(`Released — run ${cmd} in your terminal`);
    }
  };

  const [reasoning, setReasoning] = React.useState<string | null>(session.reasoning ?? null);
  React.useEffect(() => { setReasoning(session.reasoning ?? null); }, [session.reasoning]);
  const changeReasoning = async (r: string | null) => {
    try { const s = await patchSession(session.id, { reasoning: r }); setReasoning(s.reasoning ?? null); setSendError(null); }
    catch (e) { setSendError(String(e)); }
  };
  const changeModel = async (m: string) => {
    try { const s = await patchSession(session.id, { model: m }); setModel(s.model || ""); setSendError(null); }
    catch (e) { setSendError(`Could not change model: ${e}`); }
  };

  const changeAgent = async (a: string) => {
    try { const s = await patchSession(session.id, { agent: a }); setAgent(s.agent || ""); setSendError(null); }
    catch (e) { setSendError(`Could not change agent: ${e}`); }
  };

  const banner = sendError || conv.error;
  const navigate = useNavigate();
  const [renameRequest, setRenameRequest] = React.useState(0);
  const removeSession = async () => {
    try {
      await deleteSession(session.id);
      window.dispatchEvent(new Event("vibedeck:sessions"));
      navigate("/");
    } catch (e) { setSendError(`Could not delete: ${e}`); }
  };
  // a fork opens as a new session; the original stays as it is
  const fork = async (entryId?: string) => {
    try {
      const forked = await forkSession(session.id, entryId);
      window.dispatchEvent(new Event("vibedeck:sessions"));
      navigate(`/sessions/${forked.id}`);
    } catch (e) { setSendError(`Could not fork: ${e}`); }
  };
  const forkRef = React.useRef(fork);
  forkRef.current = fork;
  // Vibe forks at a user message, keeping that turn's answer: forking from an
  // answer starts at the message that asked for it
  const entriesRef = React.useRef(conv.entries);
  entriesRef.current = conv.entries;
  const forkAt = (answerId: string) => {
    const entries = entriesRef.current;
    const at = entries.findIndex(e => e.id === answerId);
    for (let i = at; i >= 0; i--) if (entries[i].type === "message" && entries[i].role === "user") return entries[i].id;
    return undefined;
  };
  // Message actions: stable callbacks so memoized entries do not re-render.
  const sendRef = React.useRef(send);
  sendRef.current = send;
  const actions = React.useMemo(() => ({
    onEdit: (t: string) => {
      setText(t);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-vd-composer]")?.focus());
    },
    onResend: (t: string) => { void sendRef.current(t, []).catch(() => {}); },
    onRewind: (id: string) => setRewindEntry(id),
    onFork: (id: string) => { void forkRef.current(forkAt(id)); },
  }), []);
  const afterRewind = (message: string, _restored: string[], errors: string[]) => {
    setRewindEntry(null);
    setText(message);
    setSendError(errors.length ? `Some files were not restored: ${errors.join("; ")}` : null);
    conv.resync();
    loadReview();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-vd-composer]")?.focus());
  };
  const steps = React.useMemo(() => groupSteps(conv.entries), [conv.entries]);
  // Long sessions open on their latest steps; older ones render on demand, so
  // switching sessions does not lay out hundreds of markdown blocks at once.
  const [shown, setShown] = React.useState(PAGE);
  const hidden = Math.max(0, steps.length - shown);
  const visibleSteps = hidden ? steps.slice(hidden) : steps;
  // Entries already in the first snapshot appear at once; only live ones animate in.
  const settled = React.useRef<Set<string> | null>(null);
  if (!settled.current && !conv.loading) settled.current = new Set(conv.entries.map(e => e.id));
  const reveal = (id: string) => !settled.current?.has(id);
  const showEarlier = () => {
    const el = scrollRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    setShown(n => n + PAGE);
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - before; });
  };

  return (
    <MessageActions.Provider value={running ? { ...actions, onRewind: undefined, onFork: undefined } : actions}>
    <div className="relative flex h-full">
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* header */}
      <div className="flex h-12 items-center gap-1 pl-5 pr-3 shrink-0">
        <div className="min-w-0 flex-1 flex items-center gap-2 text-sm">
          <span className="hidden min-w-0 shrink items-center gap-1.5 text-text-muted sm:flex" title={session.cwd}>
            <Folder size={16} className="shrink-0" />
            <span className="truncate">{session.cwd.split("/").filter(Boolean).pop() || session.cwd}</span>
          </span>
          <span className="hidden shrink-0 text-text-faint sm:inline">/</span>
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <div className="min-w-0"><SessionTitle session={session} renameRequest={renameRequest} /></div>
            <SessionMenu
              label="Session actions"
              align="start"
              trigger={<ChevronDown size={16} />}
              triggerClassName="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
              items={[
                { label: "Rename", icon: Pencil, onSelect: () => setRenameRequest(n => n + 1) },
                { label: "Fork session", icon: GitFork, onSelect: () => void fork(), disabled: running },
                { label: "Continue in the cloud", icon: Cloud, onSelect: () => setCloudOpen(true), disabled: running },
                { label: "Continue in the vibe CLI", icon: Terminal, onSelect: () => void handoffToCli(), disabled: running },
                { label: "Copy session ID", icon: Copy, onSelect: () => void navigator.clipboard?.writeText(session.id).catch(() => {}) },
                { label: "Delete session", icon: Trash2, onSelect: () => void removeSession(), danger: true, disabled: running },
              ]}
            />
          </div>
        </div>
        <button
          onClick={() => setCloudOpen(true)}
          disabled={running}
          title={running ? "Stop the turn to continue in the cloud" : "Continue this session on Vibe Code Web"}
          aria-label="Continue in cloud"
          className="shrink-0 grid h-8 w-8 place-items-center rounded-md text-text-muted hover:bg-surface-muted hover:text-text transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Cloud size={16} />
        </button>
        <CloudDialog sessionId={session.id} open={cloudOpen} onClose={() => setCloudOpen(false)} />
        {reviewSupported && (
          <button
            onClick={() => togglePanel("changes")}
            title={changedFiles ? `${changedFiles} changed file${changedFiles === 1 ? "" : "s"} to review` : "Review changes"}
            aria-label="Review changes"
            aria-pressed={reviewOpen}
            className={cn("relative shrink-0 grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-surface-muted hover:text-text",
              reviewOpen ? "bg-surface-muted text-text" : "text-text-muted")}
          >
            <FileDiff size={16} />
            {changedFiles > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                {changedFiles}
              </span>
            )}
          </button>
        )}
        <button
          onClick={() => togglePanel("activity")}
          title={liveAgents ? `${liveAgents} subagent${liveAgents === 1 ? "" : "s"} running` : "Subagents and background processes"}
          aria-label="Activity"
          aria-pressed={panel === "activity"}
          className={cn("relative shrink-0 grid h-8 w-8 place-items-center rounded-md transition-colors hover:bg-surface-muted hover:text-text",
            panel === "activity" ? "bg-surface-muted text-text" : "text-text-muted")}
        >
          <ActivityIcon size={16} />
          {liveAgents > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary animate-blink" />}
        </button>
        <button
          onClick={handoffToCli}
          disabled={running}
          title={running ? "Stop the turn to hand off to the CLI" : "Continue this session in the vibe CLI"}
          aria-label="Continue in the vibe CLI"
          className="shrink-0 grid h-8 w-8 place-items-center rounded-md text-text-muted hover:bg-surface-muted hover:text-text transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Terminal size={16} />
        </button>
        <span
          className={cn(
            "mx-2 h-2 w-2 rounded-full shrink-0",
            running ? "bg-primary animate-blink" : "bg-success",
          )}
          title={running ? "Running" : "Idle"}
        />
      </div>

      {/* messages — centered column, aligned with the composer */}
      <div ref={scrollRef} onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; setAtBottom(pinned.current); }} className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl min-h-full flex flex-col gap-1 pt-4 pb-6">
          {hidden > 0
            ? <button onClick={showEarlier} className="mx-auto my-3 rounded-md px-2.5 py-1 text-sm text-text-muted transition-colors hover:bg-surface-muted hover:text-text">Show {Math.min(hidden, PAGE)} earlier steps</button>
            : conv.historyBeforeCursor && <button onClick={() => void conv.loadEarlier()} className="mx-auto my-3 rounded-md px-2.5 py-1 text-sm text-text-muted transition-colors hover:bg-surface-muted hover:text-text">Load earlier messages</button>}
          {conv.loading && (
            <div className="my-auto flex items-center gap-2 px-6 py-8 text-text-muted text-sm">
              <Loader2 size={14} className="animate-spin text-primary" /> Loading conversation…
            </div>
          )}
          {!conv.loading && conv.entries.length === 0 && (
            <div className="my-auto px-6 py-10 text-text-muted text-sm">
              No messages yet. Send a prompt below to start the agent.
            </div>
          )}
          {visibleSteps.map((item) => item.kind === "group"
            ? <StepGroup key={item.entries[0].id} entries={item.entries} />
            : <EntryBlock key={item.entry.id} e={item.entry} onResolve={onResolve} expandReasoning={session.lane === "work"} reveal={reveal(item.entry.id)} />)}
          {running && (
            <div className="px-6 py-2 flex items-center gap-2 text-sm font-medium text-text-muted">
              <span className="vd-dots text-primary"><span /><span /><span /></span>
              <span className="vd-shimmer">Vibe is working…</span>
            </div>
          )}
        </div>
      </div>

      {/* subagent activity: running ones as chips, finished ones folded into one */}
      {childList.length > 0 && (
        <div className="shrink-0 px-6 pb-1">
          <div className="mx-auto max-w-3xl flex flex-wrap items-center gap-2">
            {childList.filter(childRunning).map((cs) => (
              <SubagentChip key={cs.id} cs={cs} />
            ))}
            {finishedAgents > 0 && (
              <button type="button" onClick={() => setPanel("activity")}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:text-text">
                <Bot size={12} className="text-text-faint" /> {finishedAgents} subagent{finishedAgents === 1 ? "" : "s"} finished
              </button>
            )}
          </div>
        </div>
      )}

      {/* stream/send error banner */}
      {banner && (
        <div className="shrink-0 px-6 pt-3">
          <div className="mx-auto max-w-3xl flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertTriangle size={13} className="shrink-0" />
            <span className="truncate">{banner}</span>
          </div>
        </div>
      )}

      {/* session setup warnings (model/agent not applied at creation) */}
      {warnings.length > 0 && (
        <div className="shrink-0 px-6 pt-3">
          <div className="mx-auto max-w-3xl flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-text">
            <AlertTriangle size={13} className="shrink-0 text-accent" />
            <span className="truncate">{warnings.join(" · ")}</span>
            <button
              onClick={() => setWarnings([])}
              aria-label="Dismiss"
              className="shrink-0 text-text-faint transition-colors hover:text-text"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* CLI handoff notice */}
      {handoff && (
        <div className="shrink-0 px-6 pt-3">
          <div className="mx-auto max-w-3xl flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-text">
            <Terminal size={13} className="shrink-0 text-primary" />
            <span className="truncate">{handoff}</span>
            <button
              onClick={() => { setReleased(false); setHandoff(null); }}
              aria-label="Continue in desktop"
              className="shrink-0 text-text-faint transition-colors hover:text-text"
            >
              Continue in desktop
            </button>
          </div>
        </div>
      )}

      {/* composer */}
      <div className="shrink-0 px-6 pt-2 pb-4">
        <div className="relative mx-auto max-w-3xl">
          {!atBottom && (
            <button
              type="button"
              onClick={() => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }}
              aria-label="Scroll to latest"
              title="Scroll to latest"
              className="vd-menu absolute -top-12 left-1/2 z-10 -ml-4 grid h-8 w-8 place-items-center rounded-full border border-border bg-surface-raised text-text-muted shadow-lg transition-colors hover:text-text"
            >
              <ArrowDown size={16} />
            </button>
          )}
          <QueueBar sessionId={session.id} queue={conv.queue} activeTurnId={conv.activeTurnId} />
          <Composer
            value={text}
            onChange={setText}
            onSend={send}
            onStop={stop}
            running={running}
            canQueue
            onShell={released ? undefined : shellCommand}
            tray={<SessionCheckout cwd={session.cwd} worktree={conv.session?.worktree} />}
            onCompact={running || released ? undefined : compact}
            // while the agent works, keep typing the next queued message
            disabled={(sending && !running) || released}
            placeholder={`Message Vibe in ${session.cwd}…`}
            model={model}
            onModelChange={changeModel}
            reasoning={reasoning}
            onReasoningChange={changeReasoning}
            agent={agent}
            onAgentChange={changeAgent}
            // live stats arrive with turns; a reopened session reports its last context use
            contextTokens={conv.stats?.contextTokens ?? conv.session?.contextUsage?.inputTokens ?? null}
            sessionTokens={conv.stats ? conv.stats.sessionPromptTokens + conv.stats.sessionCompletionTokens : null}
            footer={conv.stats ? (
              <div className="mt-2 flex items-center justify-end px-1 text-xs text-text-faint font-mono">
                {formatTokens(conv.stats.sessionPromptTokens + conv.stats.sessionCompletionTokens)} tokens
                {conv.stats.toolCallsSucceeded > 0 && ` · ${conv.stats.toolCallsSucceeded} tool calls`}
              </div>
            ) : undefined}
          />
        </div>
      </div>
    </div>
    {reviewOpen && reviewSupported && (
      <ReviewPanel sessionId={session.id} review={review} running={running} onChange={setReview} onClose={() => setPanel(null)} />
    )}
    {panel === "activity" && (
      <ActivityPanel sessionId={session.id} running={running} refreshKey={conv.childSessions} onClose={() => setPanel(null)} />
    )}
    </div>
    <RewindDialog sessionId={session.id} cwd={session.cwd} entryId={rewindEntry} onClose={() => setRewindEntry(null)} onDone={afterRewind} />
    </MessageActions.Provider>
  );
}

// ---------------------------------------------------------------- subagent chip

function childRunning(cs: ChildSession) {
  return (typeof cs.status === "string" ? cs.status : cs.status?.type) === "running";
}

function SubagentChip({ cs }: { cs: ChildSession }) {
  const status = typeof cs.status === "string" ? cs.status : cs.status?.type || "";
  const running = status === "running";
  const tokens = cs.tokenUsage?.totalTokens ?? 0;
  return (
    <div
      className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-text-muted"
      title={`${cs.name} — subagent spawned by the model`}
    >
      <Bot size={12} className={cn("shrink-0", running ? "text-primary" : "text-text-faint")} />
      <span className="text-text">{cs.name}</span>
      <span className={cn(
        "h-1.5 w-1.5 rounded-full shrink-0",
        running ? "bg-primary animate-blink" : status === "failed" ? "bg-danger" : "bg-success",
      )} />
      <span className="text-text-faint">{status}</span>
      {tokens > 0 && <span className="text-text-faint font-mono">{formatTokens(tokens)}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- editable title

function SessionTitle({ session, renameRequest = 0 }: { session: Session; renameRequest?: number }) {
  const [editing, setEditing] = React.useState(false);
  React.useEffect(() => { if (renameRequest) setEditing(true); }, [renameRequest]);
  const [title, setTitle] = React.useState(session.title);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => { setTitle(session.title); }, [session.title]);

  const save = async () => {
    const t = title.trim();
    setEditing(false);
    if (!t || t === session.title || busy) return;
    setBusy(true);
    try {
      await patchSession(session.id, { title: t });
      window.dispatchEvent(new Event("vibedeck:sessions"));
    } catch {
      setTitle(session.title);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") { setTitle(session.title); setEditing(false); }
        }}
        className="w-72 max-w-full bg-transparent text-sm text-text focus:outline-none border-b border-border focus:border-primary"
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      title="Rename session"
      className="group flex h-7 items-center gap-1.5 rounded-md px-1.5 -ml-1.5 text-sm text-text truncate text-left max-w-full transition-colors hover:bg-surface-muted"
    >
      <span className="truncate">{session.title}</span>
      <Pencil size={14} className="shrink-0 text-text-faint opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

/** Where this session works: its folder or Vibe worktree, and the branch there. */
function SessionCheckout({ cwd, worktree }: { cwd: string; worktree?: { name?: string; branch?: string; path?: string } | null }) {
  const Icon = worktree?.name ? FolderTree : Folder;
  return (
    <>
      <span className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-xs text-text-muted" title={cwd}>
        <Icon size={13} className="shrink-0" />
        <span className="truncate">{worktree?.name ? `Worktree ${worktree.name}` : cwd.split("/").filter(Boolean).pop() || cwd}</span>
      </span>
      <div className="flex-1" />
      <BranchPicker compact align="end" cwd={cwd} />
    </>
  );
}
