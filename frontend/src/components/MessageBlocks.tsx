import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  Lightbulb, Wrench, ShieldCheck, ChevronRight, Terminal, FileCode2,
  Loader2, X, Sparkles, Copy, Check, Pencil, RotateCcw, History, GitFork, Shrink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { interruptShell } from "@/lib/api";
import { Badge, usePresence } from "./ui";
import type { HistoryEntry } from "@/lib/types";
import { durationSeconds, isManualShell, stepStatus, summarizeSteps } from "@/lib/steps";

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

// ---------------------------------------------------------------- Message actions

/** Composer hooks for the per-message actions; provided by the conversation. */
export const MessageActions = React.createContext<{
  onEdit?: (text: string) => void;
  onResend?: (text: string) => void;
  onRewind?: (entryId: string) => void;
  onFork?: (entryId: string) => void;
}>({});

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number>();
  React.useEffect(() => () => window.clearTimeout(timer.current), []);
  return [copied, (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }];
}

const actionBtn = "grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text";

function ActionBar({ text, user, id }: { text: string; user: boolean; id?: string }) {
  const { onEdit, onResend, onRewind, onFork } = React.useContext(MessageActions);
  const [copied, copy] = useCopy();
  if (!text) return null;
  return (
    <div className={cn(
      "mt-0.5 flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 focus-within:opacity-100",
      user && "justify-end",
    )}>
      <button type="button" onClick={() => copy(text)} className={actionBtn} title={copied ? "Copied" : "Copy"} aria-label={copied ? "Copied" : "Copy message"}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
      {user && onEdit && <button type="button" onClick={() => onEdit(text)} className={actionBtn} title="Edit in composer" aria-label="Edit message in composer"><Pencil size={16} /></button>}
      {user && onResend && <button type="button" onClick={() => onResend(text)} className={actionBtn} title="Send again" aria-label="Send message again"><RotateCcw size={16} /></button>}
      {!user && onFork && id && <button type="button" onClick={() => onFork(id)} className={actionBtn} title="Fork from here" aria-label="Fork the conversation into a new session from here"><GitFork size={16} /></button>}
      {user && onRewind && id && <button type="button" onClick={() => onRewind(id)} className={actionBtn} title="Rewind to this message" aria-label="Rewind the conversation to this message"><History size={16} /></button>}
    </div>
  );
}

// ---------------------------------------------------------------- Code blocks

function nodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node)) return nodeText((node.props as { children?: React.ReactNode }).children);
  return "";
}

/** Fenced code: a header with the language and a copy button above the block. */
function CodeBlock({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) {
  const code = React.Children.toArray(children)[0];
  const className = React.isValidElement(code) ? String((code.props as { className?: string }).className || "") : "";
  const language = /language-([\w+-]+)/.exec(className)?.[1];
  const [copied, copy] = useCopy();
  return (
    <div className="vd-code group/code relative my-3 overflow-hidden rounded-xl border border-border bg-code">
      <div className="flex h-9 items-center justify-between pl-4 pr-1 text-xs text-text-muted">
        <span className="font-mono">{language || "text"}</span>
        <button type="button" onClick={() => copy(nodeText(children).replace(/\n$/, ""))} className={cn(actionBtn, "h-7 w-7")}
          title={copied ? "Copied" : "Copy code"} aria-label={copied ? "Copied" : "Copy code"}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

const markdownComponents = { pre: CodeBlock };
const rehypePlugins: React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"] = [[rehypeHighlight, { detect: false }]];

/** Markdown rendered the way assistant messages are. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("prose-vd", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={markdownComponents}>{text}</ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------- User / Assistant message

export function MessageEntry({ e, reveal = true }: { e: HistoryEntry; reveal?: boolean }) {
  const isUser = e.role === "user";
  const images = (e.content || []).map((content, i) => {
    const attachment = content.attachment as any;
    const url = attachment?.source?.kind === "inline" ? `data:${attachment.mimeType};base64,${attachment.source.data}` : null;
    return content.type === "image" && typeof url === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(url)
      ? <img key={i} src={url} alt={attachment?.alias || "Attached image"} className="mb-2 max-h-64 max-w-full rounded-lg" /> : null;
  });
  // User turns are a right-aligned pill; assistant turns are plain markdown —
  // no avatars, like the webapp. The speaker stays available to screen readers.
  const text = entryText(e);
  if (isUser) {
    return (
      <div className={cn("group/message flex flex-col items-end px-6 pt-3 pb-0", reveal && "vd-reveal")}>
        <div className="flex w-fit max-w-[85%] min-w-0 flex-col rounded-3xl bg-surface-muted/70 px-5 py-3">
          <span className="sr-only">You:</span>
          {images}
          <div className="whitespace-pre-wrap break-words text-base leading-6">{text}</div>
        </div>
        <ActionBar text={text} user id={e.id} />
      </div>
    );
  }
  return (
    <div className={cn("group/message px-6 pt-3 pb-0", reveal && "vd-reveal")}>
      <span className="sr-only">Vibe:</span>
      {images}
      <div className="prose-vd">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={markdownComponents}>{text}</ReactMarkdown>
      </div>
      <ActionBar text={text} user={false} id={e.id} />
    </div>
  );
}

// ---------------------------------------------------------------- Disclosure row

/** A muted 14px row with a trailing chevron that brightens on hover — the
 *  webapp's collapsible step header (tool calls, reasoning). */
function DisclosureRow({
  open, onToggle, controls, icon: Icon, label, detail, busy = false, trailing,
}: {
  open: boolean; onToggle: () => void; controls: string; icon: React.ElementType;
  label: string; detail?: string; busy?: boolean; trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="group flex h-6 w-full min-w-0 items-center gap-2 text-left text-sm font-medium text-text-muted transition-colors hover:text-text"
    >
      <Icon size={16} className="shrink-0" />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={cn("shrink-0", busy && "vd-shimmer")}>{label}</span>
        {detail && <span className="min-w-0 truncate font-mono text-[13px] font-normal">{detail}</span>}
      </span>
      {trailing}
      <ChevronRight size={16} className={cn("vd-disclosure-chevron shrink-0", open && "rotate-90")} />
    </button>
  );
}

// ---------------------------------------------------------------- Reasoning (thinking)

export function ReasoningBlock({ e, defaultExpanded = false }: { e: HistoryEntry; defaultExpanded?: boolean }) {
  const [open, setOpen] = React.useState(defaultExpanded);
  const body = usePresence(open, 300);
  const contentId = React.useId();
  const text = e.text || "";
  const streaming = e.generationStatus === "in_progress";
  const seconds = streaming ? null : durationSeconds(e);
  const label = streaming ? "Thinking…" : seconds ? `Thought for ${seconds}s` : "Thought process";
  return (
    <div className="px-6 py-1.5">
      <DisclosureRow open={open} onToggle={() => setOpen((v) => !v)} controls={contentId}
        icon={Lightbulb} label={label} busy={streaming} />
      <div className="vd-collapse" data-open={open}>
        <div id={contentId}>{body.mounted && <>
          <div className="mt-2 ml-2 border-l border-border pl-4 text-sm leading-6 text-text-muted whitespace-pre-wrap">
            {text || <span className="text-text-faint">…</span>}
          </div>
        </>}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Tool call (effect)

const toolIcon = (name: string) => {
  if (name.includes("bash") || name.includes("shell")) return Terminal;
  if (name.includes("read") || name.includes("write") || name.includes("edit") || name.includes("file")) return FileCode2;
  return Wrench;
};

// ---------------------------------------------------------------- Step group

/** Consecutive tool calls folded into one summary row; expands to the calls. */
export const StepGroup = React.memo(function StepGroup({ entries }: { entries: HistoryEntry[] }) {
  const [open, setOpen] = React.useState(false);
  const body = usePresence(open, 300);
  const contentId = React.useId();
  const statuses = entries.map(stepStatus);
  const running = statuses.includes("running");
  const failed = statuses.filter(s => s === "failed").length;
  return (
    <div className="py-1.5">
      <div className="px-6">
        <DisclosureRow open={open} onToggle={() => setOpen(v => !v)} controls={contentId}
          icon={Wrench} label={summarizeSteps(entries)} busy={running}
          trailing={failed ? <span className="shrink-0 text-xs text-danger">{failed} failed</span> : undefined} />
      </div>
      <div className="vd-collapse" data-open={open}>
        <div id={contentId}>{body.mounted && <>
          <div className="mt-1 ml-8 border-l border-border [&>div]:px-4">
            {entries.map(e => <ToolCallBlock key={e.id} e={e} />)}
          </div>
        </>}</div>
      </div>
    </div>
  );
}, (a, b) => a.entries.length === b.entries.length && a.entries.every((e, i) => e === b.entries[i]));

export function ToolCallBlock({ e }: { e: HistoryEntry }) {
  const [open, setOpen] = React.useState(false);
  const body = usePresence(open, 300);
  const contentId = React.useId();
  const d: any = e.detail || {};
  const st: any = e.state || {};
  const name = d?.toolName || e.title || "tool";
  const Icon = toolIcon(name);
  const status = st.status || "running";
  const output = toolOutput(e);
  const input = toolInput(e);
  const running = status === "running" || status === "in_progress";
  const failed = status === "failed" || status === "error";
  return (
    <div className="px-6 py-1.5">
      <DisclosureRow open={open} onToggle={() => setOpen((v) => !v)} controls={contentId}
        icon={Icon} label={name} detail={toolSummary(e)} busy={running}
        trailing={<StatusMark status={status} />} />
      <div className="vd-collapse" data-open={open}>
        <div id={contentId}>{body.mounted && <>
          <div className={cn("mt-2 ml-6 space-y-2", failed && "text-danger")}>
            {input && (
              <div>
                <div className="text-xs font-medium text-text-faint mb-1">Input</div>
                <pre className="font-mono text-xs bg-code border border-border rounded-lg p-3 overflow-x-auto text-text-muted">{input}</pre>
              </div>
            )}
            {output && (
              <div>
                <div className="text-xs font-medium text-text-faint mb-1">Output</div>
                <pre className="font-mono text-xs bg-code border border-border rounded-lg p-3 overflow-x-auto max-h-60 text-text-muted whitespace-pre-wrap">{output}</pre>
              </div>
            )}
            {!input && !output && (
              <div className="text-xs text-text-faint">No details.</div>
            )}
          </div>
        </>}</div>
      </div>
    </div>
  );
}

/** Finished steps stay quiet; only running and failed steps get a mark. */
function StatusMark({ status }: { status: string }) {
  if (status === "running" || status === "in_progress")
    return <Loader2 size={14} aria-label="Running" className="animate-spin text-text-faint shrink-0" />;
  if (status === "failed" || status === "error")
    return <X size={14} aria-label="Failed" className="text-danger shrink-0" />;
  return null;
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
      <div className="rounded-xl border border-border bg-surface px-4 py-3.5 shadow-[0_1px_2px_rgb(0_0_0/0.12)] animate-fade-in">
        <div className="flex items-start gap-3">
          <ShieldCheck size={16} className="text-primary mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-text">
              {open ? "Approval required" : answered ? "Approval resolved" : e.title || "Approval"}
            </div>
            <div className="text-[13px] text-text-muted mt-1 font-mono break-all">
              {effect ? toolSummary(effect) : e.title}
            </div>
            {reason && <div className="text-xs text-text-faint mt-1">{reason}</div>}
            {open && (
              <div className="flex flex-wrap items-center gap-2 mt-3">
                {choices.map(choice => <button key={choice} disabled={busy !== null} onClick={() => void act(choice)}
                  className={cn("h-8 px-3 rounded-md text-sm font-medium transition-colors duration-75 ease-out disabled:opacity-50", choice === "approve" ? "vd-send" : "border border-border text-text hover:bg-surface-muted")}>
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
  return <div className="px-6 py-2"><div className="rounded-xl border border-border bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.12)]">
    <h3 className="text-sm font-medium">{open ? "Vibe needs your input" : "Input resolved"}</h3>
    {open && <form onSubmit={event => { event.preventDefault(); void submit(false); }} className="mt-3 space-y-4">
      {questions.map((q: any, i: number) => <fieldset key={i} disabled={busy} className="space-y-2">
        <legend className="mb-2 text-sm">{q.question}</legend>
        {(q.options || []).map((option: any) => <label key={option.label} className="flex items-start gap-2 text-sm text-text-muted">
          <input type={q.multiSelect ? "checkbox" : "radio"} name={`question-${e.id}-${i}`} checked={(selected[i] || []).includes(option.label)}
            onChange={event => setSelected(s => ({ ...s, [i]: q.multiSelect ? event.target.checked ? [...(s[i] || []), option.label] : (s[i] || []).filter(v => v !== option.label) : [option.label] }))} />
          <span>{option.label}{option.description && <span className="block text-xs text-text-faint">{option.description}</span>}</span>
        </label>)}
        {(!q.hideOther || !q.options?.length) && <input aria-label={`Your answer: ${q.question}`} value={other[i] || ""} onChange={event => setOther(s => ({ ...s, [i]: event.target.value }))} placeholder="Your answer" className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:border-border-strong" />}
      </fieldset>)}
      <div className="flex gap-2"><button disabled={busy || questions.some((_: unknown, i: number) => !selected[i]?.length && !other[i]?.trim())} className="vd-send h-8 rounded-md px-3 text-sm font-medium disabled:opacity-50">{busy ? "Sending…" : "Submit answers"}</button><button type="button" disabled={busy} onClick={() => void submit(true)} className="h-8 rounded-md px-3 text-sm text-text-muted transition-colors hover:bg-surface-muted hover:text-text">Cancel</button></div>
    </form>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div></div>;
}

// ---------------------------------------------------------------- Notice

export function NoticeBlock({ e }: { e: HistoryEntry }) {
  const d: any = e.detail || {};
  return (
    <div className="px-6 py-1.5">
      <div className="flex items-center gap-2 text-sm text-text-faint">
        <Sparkles size={16} />
        <span>{d?.title || e.title || "notice"}</span>
      </div>
    </div>
  );
}

/**
 * A command the user ran with "!": the command, its output open by default,
 * and Stop while it runs (the entry id is the shell operation id).
 */
export function ShellBlock({ e }: { e: HistoryEntry }) {
  const d: any = e.detail || {};
  const st: any = e.state || {};
  const command = d.input?.command || d.display?.message || "";
  const status = st.status || "running";
  const runningNow = status === "running" || status === "in_progress";
  const output = String(st.outputText ?? st.output?.output ?? "").replace(/\n$/, "");
  const exit = st.output?.exitCode ?? st.output?.returncode;
  const [stopping, setStopping] = React.useState(false);
  return (
    <div className="px-6 py-1.5">
      <div className="overflow-hidden rounded-xl border border-border bg-code">
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
          <Terminal size={13} className="shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 truncate font-mono text-text" title={command}><span className="text-text-faint">$ </span>{command}</span>
          {runningNow ? (
            <button type="button" disabled={stopping}
              onClick={() => { setStopping(true); void interruptShell(e.sessionId, e.id).catch(() => setStopping(false)); }}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40">
              <Loader2 size={11} className="animate-spin" /> Stop
            </button>
          ) : <StatusMark status={status} />}
          {exit != null && exit !== 0 && <span className="font-mono text-danger">exit {exit}</span>}
        </div>
        {(output || runningNow) && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 font-mono text-xs leading-5 text-text-muted">
            {output || "…"}
          </pre>
        )}
      </div>
    </div>
  );
}

/** A point where Vibe changed the conversation: a compaction or a rewind. */
export function CheckpointDivider({ e }: { e: HistoryEntry }) {
  const kind = (e as { kind?: string }).kind;
  const running = e.generationStatus && e.generationStatus !== "completed";
  const label = (e as { message?: string }).message
    || (kind === "compaction" ? "Context compacted" : kind === "rewind" ? "Conversation rewound" : "Checkpoint");
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 px-6 py-3 text-xs text-text-faint">
      <span className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5">
        {running ? <Loader2 size={12} className="animate-spin" /> : kind === "compaction" ? <Shrink size={12} /> : <History size={12} />}
        {running && kind === "compaction" ? "Compacting context…" : label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// ---------------------------------------------------------------- dispatcher

// Memoized: while a turn streams, only the updated entry gets a new object
// reference, so unchanged messages skip re-rendering on every token.
export const EntryBlock = React.memo(function EntryBlock({
  e, onResolve, expandReasoning = false, reveal = true,
}: {
  e: HistoryEntry;
  expandReasoning?: boolean;
  reveal?: boolean;
  onResolve: (callbackId: string, decision: string, userInput?: unknown) => Promise<void>;
}) {
  switch (e.type) {
    case "message":
      return <MessageEntry e={e} reveal={reveal} />;
    case "reasoning":
      return <ReasoningBlock e={e} defaultExpanded={expandReasoning} />;
    case "effect":
      return isManualShell(e) ? <ShellBlock e={e} /> : <ToolCallBlock e={e} />;
    case "callback":
      return e.detail?.kind === "user_input" ? <QuestionCard e={e} onResolve={onResolve} /> : e.detail?.kind === "approval" || !e.detail?.kind
        ? <ApprovalCard e={e} onResolve={onResolve} /> : <div role="alert" className="px-6 py-2 text-sm text-danger">This prompt requires a newer VibeDeck client. Stop the turn and resume in the CLI.</div>;
    case "notice":
      return <NoticeBlock e={e} />;
    case "checkpoint":
      return <CheckpointDivider e={e} />;
    default:
      return (
        <div className="px-6 py-1 text-xs text-text-faint font-mono">
          {e.type}: {e.title || e.id}
        </div>
      );
  }
});
