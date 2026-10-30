import * as React from "react";
import { AlertTriangle, Bot, Loader2, Pencil, Terminal, X } from "lucide-react";
import { cn, formatTokens } from "@/lib/utils";
import { Composer, type ImageAttachment } from "./Composer";
import { EntryBlock } from "./MessageBlocks";
import { useConversation } from "@/hooks/useConversation";
import { sendTurn, interruptTurn, resolveCallback, patchSession, releaseSession } from "@/lib/api";
import { ensureNotificationPermission, notify } from "@/lib/notifications";
import type { ChildSession, Session } from "@/lib/types";

export function Conversation({ session }: { session: Session }) {
  const [released, setReleased] = React.useState(false);
  const conv = useConversation(session.id, released);
  const sendingRef = React.useRef(false);
  const requestRef = React.useRef<{ payload: string; id: string } | null>(null);
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [handoff, setHandoff] = React.useState<string | null>(null);
  const [warnings, setWarnings] = React.useState<string[]>(session.warnings ?? []);
  const [model, setModel] = React.useState(session.model || "");
  const [agent, setAgent] = React.useState(session.agent || "");
  React.useEffect(() => { setModel(session.model || ""); setAgent(session.agent || ""); }, [session.model, session.agent]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);

  React.useEffect(() => {
    if (conv.session?.model) setModel(conv.session.model);
    const acceptedAgent = conv.session?.agent;
    if (acceptedAgent) setAgent(typeof acceptedAgent === "string" ? acceptedAgent : acceptedAgent.name);
  }, [conv.session?.model, conv.session?.agent]);
  const running = conv.turnStatus === "running";

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
    if (sendingRef.current || running || released) return;
    sendingRef.current = true;
    setText("");
    setSendError(null);
    setSending(true);
    ensureNotificationPermission(); // user gesture — safe moment to ask
    try {
      const payload = JSON.stringify([text, images]);
      if (requestRef.current?.payload !== payload) requestRef.current = { payload, id: crypto.randomUUID() };
      await sendTurn(session.id, text, images, requestRef.current.id);
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

  const changeModel = async (m: string) => {
    try { const s = await patchSession(session.id, { model: m }); setModel(s.model || ""); setSendError(null); }
    catch (e) { setSendError(`Could not change model: ${e}`); }
  };

  const changeAgent = async (a: string) => {
    try { const s = await patchSession(session.id, { agent: a }); setAgent(s.agent || ""); setSendError(null); }
    catch (e) { setSendError(`Could not change agent: ${e}`); }
  };

  const banner = sendError || conv.error;

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
        <div className="min-w-0 flex-1">
          <SessionTitle session={session} />
          <div className="text-xs text-text-faint font-mono truncate">{session.cwd}</div>
        </div>
        <button
          onClick={handoffToCli}
          disabled={running}
          title={running ? "Stop the turn to hand off to the CLI" : "Continue this session in the vibe CLI"}
          aria-label="Continue in the vibe CLI"
          className="shrink-0 grid h-7 w-7 place-items-center rounded-md text-text-faint hover:bg-surface-muted hover:text-text transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Terminal size={14} />
        </button>
        <span
          className={cn(
            "h-2 w-2 rounded-full shrink-0",
            running ? "bg-primary animate-blink" : "bg-success",
          )}
          title={running ? "Running" : "Idle"}
        />
      </div>

      {/* messages — centered column, aligned with the composer */}
      <div ref={scrollRef} onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl min-h-full flex flex-col pb-6">
          {conv.historyBeforeCursor && <button onClick={() => void conv.loadEarlier()} className="mx-auto my-3 text-xs text-primary hover:underline">Load earlier messages</button>}
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
          {conv.entries.map((e) => (
            <EntryBlock key={e.id} e={e} onResolve={onResolve} expandReasoning={session.lane === "work"} />
          ))}
          {running && (
            <div className="px-6 py-2 flex items-center gap-2 text-xs text-text-muted">
              <span className="vd-dots text-primary"><span /><span /><span /></span>
              Vibe is working…
            </div>
          )}
        </div>
      </div>

      {/* subagent activity — child sessions the model spawned mid-turn */}
      {Object.keys(conv.childSessions).length > 0 && (
        <div className="shrink-0 px-6 pb-1">
          <div className="mx-auto max-w-3xl flex flex-wrap items-center gap-2">
            {Object.values(conv.childSessions).map((cs) => (
              <SubagentChip key={cs.id} cs={cs} />
            ))}
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
      <div className="shrink-0 px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <Composer
            value={text}
            onChange={setText}
            onSend={send}
            onStop={stop}
            running={running}
            disabled={sending || released}
            placeholder={`Message Vibe in ${session.cwd}…`}
            model={model}
            onModelChange={changeModel}
            agent={agent}
            onAgentChange={changeAgent}
            contextTokens={conv.stats?.contextTokens ?? null}
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
  );
}

// ---------------------------------------------------------------- subagent chip

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

function SessionTitle({ session }: { session: Session }) {
  const [editing, setEditing] = React.useState(false);
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
        className="w-full bg-transparent text-sm font-medium text-text focus:outline-none border-b border-border focus:border-primary"
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      title="Rename session"
      className="group flex items-center gap-1.5 text-sm font-medium text-text truncate text-left max-w-full"
    >
      <span className="truncate">{session.title}</span>
      <Pencil size={11} className="shrink-0 text-text-faint opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}
