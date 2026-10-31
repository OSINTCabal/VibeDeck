import * as React from "react";
import { Loader2, Repeat, Trash2 } from "lucide-react";
import { Button, Dialog } from "./ui";
import { createLoop, deleteLoop, getLoops, type SessionLoop } from "@/lib/api";

const INTERVALS = [
  { value: "5m", label: "5 minutes" }, { value: "15m", label: "15 minutes" }, { value: "30m", label: "30 minutes" },
  { value: "1h", label: "hour" }, { value: "6h", label: "6 hours" }, { value: "1d", label: "day" },
];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function every(loop: SessionLoop) {
  const s = loop.intervalSeconds;
  if (!s) return loop.cron || "on a schedule";
  return s % 86400 === 0 ? `every ${s / 86400} d` : s % 3600 === 0 ? `every ${s / 3600} h` : s % 60 === 0 ? `every ${s / 60} min` : `every ${s} s`;
}

/** Prompts Vibe sends again on an interval while this session is open, like /loop. */
export function LoopsDialog({ sessionId, open, onClose }: { sessionId: string; open: boolean; onClose: () => void }) {
  const [loops, setLoops] = React.useState<SessionLoop[] | null>(null);
  const [prompt, setPrompt] = React.useState("");
  const [interval, setInterval] = React.useState("15m");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    getLoops(sessionId).then(d => setLoops(d.loops)).catch(e => { setLoops([]); setError(message(e)); });
  }, [open, sessionId]);

  const act = async (fn: () => Promise<{ loops: SessionLoop[] }>) => {
    setBusy(true); setError(null);
    try { setLoops((await fn()).loops); return true; } catch (e) { setError(message(e)); return false; } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Repeat a prompt" className="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-text-muted">Vibe sends the prompt again on a schedule while this session is open, for checks like “Is CI green yet?”.</p>
        {loops === null ? <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</p>
          : loops.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {loops.map(loop => (
                <li key={loop.id} className="flex items-center gap-2 px-3 py-2">
                  <Repeat size={13} className="shrink-0 text-text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm" title={loop.prompt}>{loop.prompt}</span>
                  <span className="shrink-0 text-[11px] text-text-faint">{every(loop)}</span>
                  <button type="button" disabled={busy} aria-label={`Stop repeating “${loop.prompt}”`}
                    onClick={() => void act(() => deleteLoop(sessionId, loop.id))}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40">
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        <form className="space-y-2" onSubmit={e => {
          e.preventDefault();
          if (prompt.trim()) void act(() => createLoop(sessionId, interval, prompt.trim())).then(ok => { if (ok) setPrompt(""); });
        }}>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2} placeholder="Check whether the deploy finished and summarise any errors"
            aria-label="Prompt to repeat"
            className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-border-strong" />
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-muted" htmlFor="loop-interval">Every</label>
            <select id="loop-interval" value={interval} onChange={e => setInterval(e.target.value)}
              className="h-8 rounded-md border border-border bg-surface px-2 text-sm text-text">
              {INTERVALS.map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
            </select>
            <div className="flex-1" />
            <Button type="submit" variant="primary" size="sm" disabled={busy || !prompt.trim()}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Repeat size={13} />} Repeat
            </Button>
          </div>
        </form>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
