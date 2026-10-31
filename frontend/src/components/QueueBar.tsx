import * as React from "react";
import { CornerDownLeft, ListOrdered, Pencil, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { removeQueued, replaceQueued, resumeQueue, steerQueued } from "@/lib/api";
import type { TurnQueue } from "@/lib/types";

const itemText = (item: TurnQueue["items"][number]) =>
  item.entries.flatMap(e => e.content || []).map(c => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : "")).join(" ").trim();

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iconBtn = "grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text disabled:opacity-40";

/**
 * Messages waiting for the running turn to end. Each can be edited, removed,
 * or sent into the running turn now; a paused queue (after a stop or an
 * error) can be resumed.
 */
export function QueueBar({ sessionId, queue, activeTurnId }: {
  sessionId: string;
  queue: TurnQueue | null;
  activeTurnId: string | null;
}) {
  const [editing, setEditing] = React.useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const items = queue?.items || [];
  React.useEffect(() => { if (editing && !items.some(i => i.id === editing.id)) setEditing(null); }, [items, editing]);
  if (!items.length) return null;

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const save = () => {
    if (!editing) return;
    const text = editing.text.trim();
    void act(async () => { if (text) await replaceQueued(sessionId, editing.id, text); setEditing(null); });
  };

  return (
    <div className="mx-auto mb-2 max-w-3xl px-1">
      <div className="rounded-xl border border-border bg-surface/60 px-2 py-1.5">
        <div className="flex items-center gap-1.5 px-1 pb-1 text-xs text-text-muted">
          <ListOrdered size={13} />
          <span className="flex-1">{items.length} queued · {queue?.paused ? "paused" : "runs after this turn"}</span>
          {queue?.paused && (
            <button type="button" disabled={busy} onClick={() => void act(() => resumeQueue(sessionId))}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-primary hover:bg-surface-muted disabled:opacity-40">
              <Play size={11} /> Resume
            </button>
          )}
        </div>
        <ol className="space-y-0.5">
          {items.map((item, i) => (
            <li key={item.id} className="group flex items-center gap-1.5 rounded-lg px-1 py-0.5 hover:bg-surface-muted/50">
              <span className="w-4 shrink-0 text-center text-[11px] text-text-faint">{i + 1}</span>
              {editing?.id === item.id ? (
                <input autoFocus value={editing.text} aria-label="Edit queued message"
                  onChange={e => setEditing({ id: item.id, text: e.target.value })}
                  onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(null); }}
                  onBlur={save}
                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-text focus:outline-none focus:border-border-strong" />
              ) : (
                <span className="min-w-0 flex-1 truncate text-sm text-text" title={itemText(item)}>{itemText(item)}</span>
              )}
              <span className={cn("flex items-center gap-0.5", editing?.id !== item.id && "opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100")}>
                {activeTurnId && (
                  <button type="button" disabled={busy} title="Send into the running turn now" aria-label="Send now"
                    onClick={() => void act(() => steerQueued(sessionId, item.id, activeTurnId))} className={iconBtn}>
                    <CornerDownLeft size={13} />
                  </button>
                )}
                <button type="button" disabled={busy} title="Edit" aria-label="Edit queued message"
                  onClick={() => setEditing({ id: item.id, text: itemText(item) })} className={iconBtn}>
                  <Pencil size={12} />
                </button>
                <button type="button" disabled={busy} title="Remove from queue" aria-label="Remove queued message"
                  onClick={() => void act(() => removeQueued(sessionId, item.id))} className={iconBtn}>
                  <X size={13} />
                </button>
              </span>
            </li>
          ))}
        </ol>
        {error && <p role="alert" className="px-1 pt-1 text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}
