import * as React from "react";
import { ArrowUp, Loader2, Plus, Square, X } from "lucide-react";
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
  running = false, disabled = false,
  placeholder = "Type / for quick access",
  model, onModelChange, agent, onAgentChange,
  extraLeft, footer, className, sendError, contextTokens, sessionTokens, reasoning, onReasoningChange,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string, images: ImageAttachment[]) => void | Promise<void>;
  onStop?: () => void;
  running?: boolean;
  disabled?: boolean;
  placeholder?: string;
  model: string;
  onModelChange: (v: string) => void;
  agent: string;
  onAgentChange: (v: string) => void;
  extraLeft?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  sendError?: string | null;
  contextTokens?: number | null;
  sessionTokens?: number | null;
  reasoning?: string | null;
  onReasoningChange?: (v: string | null) => void;
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

  const send = async () => {
    if ((!value.trim() && images.length === 0) || running || disabled || sendLock.current) return;
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

  const onFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
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
      <div className="rounded-xl border border-border bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.12),0_6px_16px_-6px_rgb(0_0_0/0.2)] transition-colors duration-150 focus-within:border-border-strong">
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
        <textarea
          ref={taRef}
          data-vd-composer
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={sending || disabled}
          className="w-full bg-transparent px-4 pt-4 pb-0 text-base leading-6 text-text placeholder:text-text-muted resize-none focus:outline-none max-h-48"
          style={{ minHeight: 40 }}
        />
        <div className="flex items-center gap-1 px-3 pt-3 pb-3">
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
          <div className="flex-1" />
          <UsageMeter model={model} contextTokens={contextTokens} sessionTokens={sessionTokens} />
          {onReasoningChange && <EffortPicker model={model} value={reasoning ?? null} onChange={onReasoningChange} />}
          <ModelPicker value={model} onChange={onModelChange} />
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
              title="Send (Enter)"
              aria-label="Send"
              className="ml-1 h-8 w-8 shrink-0 grid place-items-center rounded-md vd-send disabled:opacity-40 disabled:pointer-events-none"
            >
              {disabled ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2} />}
            </button>
          )}
        </div>
      </div>
      {footer}
    </div>
  );
}
