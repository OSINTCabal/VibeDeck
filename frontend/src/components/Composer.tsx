import * as React from "react";
import { ArrowUp, ListPlus, Loader2, Plus, Square, Terminal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentPicker, EffortPicker, ModelPicker } from "./Pickers";
import { UsageMeter } from "./UsageMeter";

/** Image attachment in the wire format the vibe app-server expects. */
export interface ImageAttachment {
  source: { kind: "inline"; data: string };
  alias: string;
  mimeType: string;
}

interface PendingImage {
  attachment: ImageAttachment;
  previewUrl: string;
}

function readImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      const comma = url.indexOf(",");
      const data = comma >= 0 ? url.slice(comma + 1) : url;
      resolve({
        attachment: {
          source: { kind: "inline", data },
          alias: file.name || "image",
          mimeType: file.type || "image/png",
        },
        previewUrl: url,
      });
    };
    reader.onerror = () => reject(reader.error || new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Vibe webapp-style composer: a single rounded box with the textarea on top
 * and a bottom row inside the box — attach "+", extra chips (e.g. working
 * directory) and the agent chip on the left; model chip and the circular
 * send (or stop) button on the right. Image attachments show as removable
 * chips above the textarea.
 */
export function Composer({
  value, onChange, onSend, onStop,
  running = false, canQueue = false, disabled = false,
  placeholder = "Type / for quick access",
  model, onModelChange, agent, onAgentChange,
  extraLeft, tray, footer, className, onShell, sendError, contextTokens, sessionTokens, reasoning, onReasoningChange, onCompact,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string, images: ImageAttachment[]) => void | Promise<void>;
  onStop?: () => void;
  running?: boolean;
  /** While running, sending queues the message to run after the turn. */
  canQueue?: boolean;
  disabled?: boolean;
  placeholder?: string;
  model: string;
  onModelChange: (v: string) => void;
  agent: string;
  onAgentChange: (v: string) => void;
  extraLeft?: React.ReactNode;
  /** Strip under the box for where the work happens (project, checkout, branch). */
  tray?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  sendError?: string | null;
  contextTokens?: number | null;
  sessionTokens?: number | null;
  reasoning?: string | null;
  onReasoningChange?: (v: string | null) => void;
  onCompact?: () => Promise<void>;
  /** "!command" runs in the session's folder instead of going to the model. */
  onShell?: (command: string) => Promise<void>;
}) {
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [images, setImages] = React.useState<PendingImage[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const sendLock = React.useRef(false);

  // auto-grow with content, like the webapp (capped)
  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 192) + "px";
  }, [value]);

  const shell = !!onShell && !running && value.trimStart().startsWith("!");
  const send = async () => {
    if (shell) {
      const command = value.trimStart().slice(1).trim();
      if (!command || disabled || sendLock.current) return;
      sendLock.current = true;
      setSending(true);
      setError(null);
      try { await onShell!(command); onChange(""); }
      catch (e) { setError(String(e)); }
      finally { sendLock.current = false; setSending(false); }
      return;
    }
    if ((!value.trim() && images.length === 0) || (running && !canQueue) || disabled || sendLock.current) return;
    sendLock.current = true;
    setSending(true);
    setError(null);
    try {
      await onSend(value, images.map(i => i.attachment));
      setImages([]);
    } catch (e) { if (sendError === undefined) setError(String(e)); }
    finally { sendLock.current = false; setSending(false); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const [dragging, setDragging] = React.useState(false);

  // Palette actions (e.g. "Use skill") drop text into the composer.
  const valueRef = React.useRef(value);
  valueRef.current = value;
  React.useEffect(() => {
    const onInsert = (event: Event) => {
      const text = (event as CustomEvent).detail;
      if (typeof text !== "string" || disabled) return;
      const current = valueRef.current;
      onChange(current && !current.endsWith(" ") && !current.endsWith("\n") ? `${current} ${text}` : current + text);
      requestAnimationFrame(() => taRef.current?.focus());
    };
    window.addEventListener("vibedeck:insert", onInsert);
    return () => window.removeEventListener("vibedeck:insert", onInsert);
  }, [onChange, disabled]);

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    await addFiles(files);
  };

  // Images pasted or dropped onto the composer attach like picked files.
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files || []).filter(f => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    setDragging(false);
    const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (![...e.dataTransfer.items].some(i => i.kind === "file")) return;
    e.preventDefault();
    setDragging(true);
  };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    try {
      if (files.some(f => !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.type) || f.size > 10 * 1024 * 1024)) throw new Error("Choose images up to 10 MB each.");
      if (images.length + files.length > 8) throw new Error("Attach up to 8 images.");
      const read = await Promise.all(files.map(readImage));
      setImages(prev => [...prev, ...read]);
      setError(null);
    } catch (e) { setError(String(e)); }
  };

  return (
    <div className={cn("w-full", className)}>
      {(error || sendError) && <p role="alert" className="mb-2 text-xs text-danger">{error || sendError}</p>}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
        className={cn(
          "rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.12),0_6px_16px_-6px_rgb(0_0_0/0.2)] transition-colors duration-150 focus-within:border-border-strong",
          dragging && "border-primary/60 bg-primary/5",
        )}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pt-4">
            {images.map((img, i) => (
              <span
                key={i}
                className="flex items-center gap-1.5 rounded-md bg-surface-muted px-1.5 py-1 text-xs text-text-muted"
              >
                <img src={img.previewUrl} alt="" className="h-6 w-6 rounded object-cover" />
                <span className="max-w-[140px] truncate font-mono">{img.attachment.alias}</span>
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${img.attachment.alias}`}
                  className="text-text-faint transition-colors hover:text-text"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {shell && (
          <div className="flex items-center gap-1.5 px-4 pt-3 text-xs text-text-muted">
            <Terminal size={12} className="shrink-0 text-primary" />
            Shell command: runs in the session folder, and Vibe sees its output
          </div>
        )}
        <textarea
          ref={taRef}
          data-vd-composer
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          rows={1}
          disabled={(sending && !running) || disabled}
          className="w-full bg-transparent px-4 pt-4 pb-0 text-base leading-6 text-text placeholder:text-text-muted resize-none focus:outline-none max-h-48"
          style={{ minHeight: 40 }}
        />
        {/* wraps on narrow windows instead of pushing the send button out of the box */}
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-3 pt-3 pb-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onFiles}
            aria-hidden="true"
            tabIndex={-1}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            title="Attach image (vision models)"
            aria-label="Attach image"
            className="h-8 w-8 shrink-0 grid place-items-center rounded-md text-text transition-colors duration-75 ease-out hover:bg-surface-muted"
          >
            <Plus size={16} />
          </button>
          {extraLeft}
          <AgentPicker value={agent} onChange={onAgentChange} />
          <div className="ml-auto flex shrink-0 items-center gap-1">
          <UsageMeter model={model} contextTokens={contextTokens} sessionTokens={sessionTokens} onCompact={onCompact} />
          {onReasoningChange && <EffortPicker model={model} value={reasoning ?? null} onChange={onReasoningChange} />}
          <ModelPicker value={model} onChange={onModelChange} />
          {running && canQueue && (value.trim() || images.length > 0) && (
            <button
              type="button"
              onClick={send}
              disabled={disabled || sending}
              title="Queue to run after this turn (Enter)"
              aria-label="Queue message"
              className="ml-1 h-8 w-8 shrink-0 grid place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text disabled:opacity-40"
            >
              <ListPlus size={16} />
            </button>
          )}
          {running ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop (interrupt turn)"
              aria-label="Stop"
              className="ml-1 h-8 w-8 shrink-0 grid place-items-center rounded-md vd-send"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={(!value.trim() && images.length === 0) || disabled}
              title={shell ? "Run command (Enter)" : "Send (Enter)"}
              aria-label={shell ? "Run command" : "Send"}
              className="ml-1 h-8 w-8 shrink-0 grid place-items-center rounded-md vd-send disabled:opacity-40 disabled:pointer-events-none"
            >
              {disabled ? <Loader2 size={16} className="animate-spin" /> : shell ? <Terminal size={15} /> : <ArrowUp size={16} strokeWidth={2} />}
            </button>
          )}
          </div>
        </div>
      </div>
      {tray && (
        <div className="mx-3 flex items-center gap-1 rounded-b-xl border border-t-0 border-border bg-surface/50 px-1.5 py-1">
          {tray}
        </div>
      )}
      {footer}
    </div>
  );
}
