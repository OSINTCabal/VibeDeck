import * as React from "react";
import { CircleAlert, History, Loader2 } from "lucide-react";
import { Button, Dialog } from "./ui";
import { previewRewind, rewindTo } from "@/lib/api";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Rewind the conversation to a user message: that message and everything
 * after it are dropped, and its text goes back into the composer. Files the
 * agent changed since can be restored too.
 */
export function RewindDialog({ sessionId, cwd, entryId, onClose, onDone }: {
  sessionId: string;
  cwd: string;
  entryId: string | null;
  onClose: () => void;
  onDone: (text: string, restored: string[], errors: string[]) => void;
}) {
  const [paths, setPaths] = React.useState<string[] | null>(null);
  const [restore, setRestore] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!entryId) return;
    let live = true;
    setPaths(null); setError(null); setRestore(true);
    previewRewind(sessionId, entryId)
      .then(p => { if (live) setPaths(p.paths || []); })
      .catch(e => { if (live) { setPaths([]); setError(message(e)); } });
    return () => { live = false; };
  }, [sessionId, entryId]);

  const run = async () => {
    if (!entryId || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await rewindTo(sessionId, entryId, restore && !!paths?.length);
      onDone(r.message, r.restoredPaths, r.restoreErrors);
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const prefix = cwd.replace(/\/$/, "") + "/";

  return (
    <Dialog open={!!entryId} onClose={busy ? () => {} : onClose} title="Rewind to this message" className="max-w-md">
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          This message and everything after it leave the conversation. Its text goes back into the composer so you can edit and send it again.
        </p>
        {paths === null ? (
          <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Checking files…</p>
        ) : paths.length > 0 ? (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={restore} onChange={e => setRestore(e.target.checked)} className="accent-[hsl(var(--primary))]" />
              {paths.length === 1 ? "Restore this file to how it was" : `Restore these ${paths.length} files to how they were`}
            </label>
            <ul className="max-h-36 overflow-y-auto rounded-lg border border-border px-3 py-2 font-mono text-xs text-text-muted">
              {paths.map(p => <li key={p} className="truncate" title={p}>{p.startsWith(prefix) ? p.slice(prefix.length) : p}</li>)}
            </ul>
          </div>
        ) : !error && (
          <p className="text-sm text-text-muted">No files changed after this message.</p>
        )}
        {error && <p role="alert" className="flex gap-2 text-sm text-danger"><CircleAlert size={15} className="mt-0.5 shrink-0" />{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={busy || paths === null} onClick={() => void run()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <History size={13} />} Rewind
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
