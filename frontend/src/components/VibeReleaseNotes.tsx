import * as React from "react";
import { Loader2 } from "lucide-react";
import { Dialog } from "./ui";
import { Markdown } from "./MessageBlocks";
import { getVibeReleaseNotes } from "@/lib/api";
import type { VibeReleaseNotes as Notes } from "@/lib/types";

/** "What's new in Vibe": the release notes the installed Vibe CLI ships. */
export function VibeReleaseNotes({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = React.useState<Notes | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    getVibeReleaseNotes().then(setData).catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="What’s new in Vibe" className="max-w-xl">
      {error ? <p role="alert" className="text-sm text-danger">{error}</p>
        : !data ? <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading…</p>
        : (
          <div className="max-h-[60vh] space-y-6 overflow-y-auto pr-1">
            {data.outdated && (
              <div className="rounded-lg border border-border bg-surface p-3 text-sm">
                Vibe {data.recommended} is available. Update with
                <code className="ml-1 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs">{data.upgradeCommand}</code>
                , then restart VibeDeck.
              </div>
            )}
            {data.notes.length
              ? data.notes.map(n => <Markdown key={n.version} text={n.markdown} />)
              : <p className="text-sm text-text-muted">This Vibe install ships no release notes.</p>}
          </div>
        )}
    </Dialog>
  );
}
