import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  User, Bot, Brain, Wrench, ShieldCheck, ChevronRight, Terminal, FileCode2,
  Loader2, Check, X, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "./ui";
import type { HistoryEntry } from "@/lib/types";

// ---------------------------------------------------------------- helpers

function entryText(e: HistoryEntry): string {
  if (e.type === "message") {
    return (e.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("\n\n");
  }
  return e.text || "";
}

function toolSummary(e: HistoryEntry): string {
  const d: any = e.detail || {};
  return d?.display?.summary || d?.display?.message || e.title || "tool call";
}

function toolInput(e: HistoryEntry): string {
  const d: any = e.detail || {};
  const input = d?.input;
  if (!input) return "";
  try {
    return typeof input === "string" ? input : JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function toolOutput(e: HistoryEntry): string {
  const st: any = e.state || {};
  return st.outputText || st.output || "";
}

// ---------------------------------------------------------------- User / Assistant message

export function MessageEntry({ e }: { e: HistoryEntry }) {
  const isUser = e.role === "user";
  return (
    <div className={cn(
      "flex gap-3 px-6 py-3 vd-reveal",
      isUser && "bg-surface/50 rounded-lg my-1",
    )}>
      <div
        className={cn(
          "mt-0.5 h-7 w-7 shrink-0 rounded-full grid place-items-center",
          isUser ? "bg-surface-muted text-text-muted" : "bg-primary/15 text-primary",
        )}
      >
        {isUser ? <User size={15} /> : <Bot size={15} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-text-muted mb-1">
          {isUser ? "You" : "Vibe"}
        </div>
        {(e.content || []).map((content, i) => {
          const attachment = content.attachment as any;
          const url = attachment?.source?.kind === "inline" ? `data:${attachment.mimeType};base64,${attachment.source.data}` : null;
          return content.type === "image" && typeof url === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(url)
            ? <img key={i} src={url} alt={attachment?.alias || "Attached image"} className="mb-2 max-h-64 max-w-full rounded-lg" /> : null;
        })}
        {isUser ? (
          <div className="whitespace-pre-wrap text-[15px] leading-relaxed">{entryText(e)}</div>
        ) : (
          <div className="prose-vd">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{entryText(e)}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Reasoning (thinking)

export function ReasoningBlock({ e, defaultExpanded = false }: { e: HistoryEntry; defaultExpanded?: boolean }) {
  const [open, setOpen] = React.useState(defaultExpanded);
  const contentId = React.useId();
  const text = e.text || "";
  const streaming = e.generationStatus === "in_progress";
  return (
    <div className="px-6 py-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs text-text-muted hover:text-text transition-colors"
      >
        <ChevronRight size={13} className={cn("transition-transform", open && "rotate-90")} />
        <Brain size={13} className="text-accent" />
        <span>{streaming ? "Thinking…" : "Thought process"}</span>
        {streaming && <Loader2 size={12} className="animate-spin" />}
      </button>
      {open && (
        <div id={contentId} className="mt-1 ml-5 pl-3 border-l border-border text-sm text-text-muted whitespace-pre-wrap leading-relaxed animate-fade-in">
          {text || <span className="text-text-faint">…</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Tool call (effect)

const toolIcon = (name: string) => {
  if (name.includes("bash") || name.includes("shell")) return Terminal;
  if (name.includes("read") || name.includes("write") || name.includes("edit") || name.includes("file")) return FileCode2;
  return Wrench;
};

export function ToolCallBlock({ e }: { e: HistoryEntry }) {
  const [open, setOpen] = React.useState(false);
  const d: any = e.detail || {};
  const st: any = e.state || {};
  const name = d?.toolName || e.title || "tool";
  const Icon = toolIcon(name);
  const status = st.status || "running";
  const output = toolOutput(e);
  const input = toolInput(e);
  return (
    <div className="px-6 py-1">
      <div className="rounded-lg border border-border bg-surface/60">
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-muted/40"
        >
          <Icon size={14} className="text-text-muted shrink-0" />
          <span className="font-mono text-xs text-text-muted truncate flex-1">{name}</span>
          <span className="text-xs text-text-faint truncate max-w-[45%] hidden sm:block">
            {toolSummary(e)}
          </span>
          <StatusDot status={status} />
        </button>
        {open && (
          <div className="border-t border-border px-3 py-2.5 space-y-2 animate-fade-in">
            {input && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-text-faint mb-1">Input</div>
                <pre className="font-mono text-xs bg-[#0d0b09] rounded-md p-2 overflow-x-auto text-text-muted">{input}</pre>
              </div>
            )}
            {output && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-text-faint mb-1">Output</div>
                <pre className="font-mono text-xs bg-[#0d0b09] rounded-md p-2 overflow-x-auto max-h-60 text-text-muted whitespace-pre-wrap">{output}</pre>
              </div>
            )}
            {!input && !output && (
              <div className="text-xs text-text-faint">No details.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "running" || status === "in_progress")
    return <Loader2 size={13} className="animate-spin text-primary shrink-0" />;
  if (status === "completed" || status === "succeeded" || status === "success")
    return <Check size={13} className="text-success shrink-0" />;
  if (status === "failed" || status === "error")
    return <X size={13} className="text-danger shrink-0" />;
  return <span className="h-2 w-2 rounded-full bg-text-faint shrink-0" />;
}

// ---------------------------------------------------------------- Approval card

export function ApprovalCard({
  e, onResolve,
}: {
  e: HistoryEntry;
  onResolve: (callbackId: string, decision: string, userInput?: unknown) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const d: any = e.detail || {};
  const effect: HistoryEntry | undefined = d?.effect;
  const reason = d?.reason;
  const choices: string[] = d?.choices || ["approve", "deny"];
  const open = e.state?.status === "open";
  const answered = e.state?.status && e.state.status !== "open";

  const act = async (decision: string) => {
    setBusy(decision);
    setError(null);
    try {
      await onResolve(e.callbackId || e.id, decision);
    } catch (err) { setError(String(err)); } finally {
      setBusy(null);
    }
  };

  return (
    <div className="px-6 py-2">
      <div className="rounded-lg border border-accent/40 bg-accent/5 px-4 py-3 animate-fade-in">
        <div className="flex items-start gap-2.5">
          <ShieldCheck size={16} className="text-accent mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text">
              {open ? "Approval required" : answered ? "Approval resolved" : e.title || "Approval"}
            </div>
            <div className="text-xs text-text-muted mt-0.5 font-mono break-all">
              {effect ? toolSummary(effect) : e.title}
            </div>
            {reason && <div className="text-xs text-text-faint mt-1">{reason}</div>}
            {open && (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                {choices.map(choice => <button key={choice} disabled={busy !== null} onClick={() => void act(choice)}
                  className={cn("h-8 px-3 rounded-md border border-border text-xs transition-colors disabled:opacity-50", choice === "approve" ? "bg-primary text-primary-foreground" : "text-text-muted hover:bg-surface-muted")}>
                  {busy === choice ? "Sending…" : ({ approve: "Approve", approve_for_session: "Approve for session", approve_permanently: "Always approve", deny: "Deny", cancel_turn: "Cancel turn" } as Record<string, string>)[choice] || choice}
                </button>)}
              </div>
            )}
            {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
            {answered && (
              <div className="mt-2">
                <Badge tone={e.state?.status === "answered" ? "success" : "default"}>
                  {e.state?.status}
                </Badge>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Question callback

export function QuestionCard({ e, onResolve }: {
  e: HistoryEntry;
  onResolve: (callbackId: string, decision: string, userInput?: unknown) => Promise<void>;
}) {
  const questions = e.detail?.request?.questions || [];
  const [selected, setSelected] = React.useState<Record<number, string[]>>({});
  const [other, setOther] = React.useState<Record<number, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const open = e.state?.status === "open";
  const submit = async (cancelled: boolean) => {
    setBusy(true); setError(null);
    try {
      await onResolve(e.callbackId || e.id, "approve", { cancelled, answers: cancelled ? [] : questions.map((q: any, i: number) => ({
        question: q.question, answer: [...(selected[i] || []), ...(other[i]?.trim() ? [other[i].trim()] : [])].join(", "), isOther: !!other[i]?.trim(),
      })) });
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  };
  return <div className="px-6 py-2"><div className="rounded-lg border border-accent/40 bg-accent/5 p-4">
    <h3 className="text-sm font-medium">{open ? "Vibe needs your input" : "Input resolved"}</h3>
    {open && <form onSubmit={event => { event.preventDefault(); void submit(false); }} className="mt-3 space-y-4">
      {questions.map((q: any, i: number) => <fieldset key={i} disabled={busy} className="space-y-2">
        <legend className="mb-2 text-sm">{q.question}</legend>
        {(q.options || []).map((option: any) => <label key={option.label} className="flex items-start gap-2 text-sm text-text-muted">
          <input type={q.multiSelect ? "checkbox" : "radio"} name={`question-${e.id}-${i}`} checked={(selected[i] || []).includes(option.label)}
            onChange={event => setSelected(s => ({ ...s, [i]: q.multiSelect ? event.target.checked ? [...(s[i] || []), option.label] : (s[i] || []).filter(v => v !== option.label) : [option.label] }))} />
          <span>{option.label}{option.description && <span className="block text-xs text-text-faint">{option.description}</span>}</span>
        </label>)}
        {(!q.hideOther || !q.options?.length) && <input aria-label={`Your answer: ${q.question}`} value={other[i] || ""} onChange={event => setOther(s => ({ ...s, [i]: event.target.value }))} placeholder="Your answer" className="w-full rounded-md border border-border bg-surface p-2 text-sm" />}
      </fieldset>)}
      <div className="flex gap-2"><button disabled={busy || questions.some((_: unknown, i: number) => !selected[i]?.length && !other[i]?.trim())} className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">{busy ? "Sending…" : "Submit answers"}</button><button type="button" disabled={busy} onClick={() => void submit(true)} className="px-3 py-2 text-xs text-text-muted">Cancel</button></div>
    </form>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div></div>;
}

// ---------------------------------------------------------------- Notice

export function NoticeBlock({ e }: { e: HistoryEntry }) {
  const d: any = e.detail || {};
  return (
    <div className="px-6 py-1">
      <div className="flex items-center gap-2 text-xs text-text-faint">
        <Sparkles size={12} />
        <span>{d?.title || e.title || "notice"}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- dispatcher

// Memoized: while a turn streams, only the updated entry gets a new object
// reference, so unchanged messages skip re-rendering on every token.
export const EntryBlock = React.memo(function EntryBlock({
  e, onResolve, expandReasoning = false,
}: {
  e: HistoryEntry;
  expandReasoning?: boolean;
  onResolve: (callbackId: string, decision: string, userInput?: unknown) => Promise<void>;
}) {
  switch (e.type) {
    case "message":
      return <MessageEntry e={e} />;
    case "reasoning":
      return <ReasoningBlock e={e} defaultExpanded={expandReasoning} />;
    case "effect":
      return <ToolCallBlock e={e} />;
    case "callback":
      return e.detail?.kind === "user_input" ? <QuestionCard e={e} onResolve={onResolve} /> : e.detail?.kind === "approval" || !e.detail?.kind
        ? <ApprovalCard e={e} onResolve={onResolve} /> : <div role="alert" className="px-6 py-2 text-sm text-danger">This prompt requires a newer VibeDeck client. Stop the turn and resume in the CLI.</div>;
    case "notice":
      return <NoticeBlock e={e} />;
    default:
      return (
        <div className="px-6 py-1 text-xs text-text-faint font-mono">
          {e.type}: {e.title || e.id}
        </div>
      );
  }
});
