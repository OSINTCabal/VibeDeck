import * as React from "react";
import { FolderTree, Loader2, Trash2 } from "lucide-react";
import { Button, Card, CardBody } from "./ui";
import { getAllWorktrees, pruneWorktrees, removeWorktree, type VibeWorktree } from "@/lib/api";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const KEPT: Record<string, string> = {
  kept_in_use: "A session is still using it.",
  kept_unmanaged: "Vibe did not create this worktree, so it leaves it alone.",
  kept_error: "Vibe could not remove it.",
  not_found: "It is already gone.",
};

/**
 * The worktrees Vibe created for sessions, in every repository VibeDeck
 * sessions have used: their branch and how far it moved, with removal and a
 * prune of the ones no session holds any more.
 */
export function WorktreesCard() {
  const [list, setList] = React.useState<VibeWorktree[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    getAllWorktrees().then(d => setList(d.worktrees)).catch(e => { setList([]); setNote(message(e)); });
  }, []);
  React.useEffect(load, [load]);

  const remove = async (wt: VibeWorktree) => {
    setBusy(wt.cwd); setNote(null);
    try {
      let r = await removeWorktree(wt.cwd);
      if (r.outcome === "kept_dirty" && window.confirm(
        `${wt.name} has ${r.reasons?.join(", ") || "changes not on any other branch"}. Discard them and remove it?`)) {
        r = await removeWorktree(wt.cwd, true);
      }
      if (r.outcome !== "removed") setNote(r.outcome === "kept_dirty" ? `${wt.name} was kept.` : `${wt.name}: ${KEPT[r.outcome] || r.outcome}`);
      load();
    } catch (e) { setNote(message(e)); }
    finally { setBusy(null); }
  };
  const prune = async () => {
    setBusy("prune"); setNote(null);
    try {
      const { removed } = await pruneWorktrees();
      setNote(removed ? `Removed ${removed} unused worktree${removed === 1 ? "" : "s"}.` : "No unused worktrees to remove.");
      load();
    } catch (e) { setNote(message(e)); }
    finally { setBusy(null); }
  };

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-text-muted">Worktrees</div>
            <p className="mt-0.5 text-xs text-text-faint">Code sessions started with “Worktree” work on their own branch in a separate checkout.</p>
          </div>
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void prune()}>
            {busy === "prune" ? <Loader2 size={13} className="animate-spin" /> : null} Remove unused
          </Button>
        </div>
        {list === null ? (
          <p className="flex items-center gap-2 text-xs text-text-muted"><Loader2 size={12} className="animate-spin" /> Looking for worktrees…</p>
        ) : list.length === 0 ? (
          <p className="text-xs text-text-muted">No worktrees yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {list.map(wt => (
              <li key={wt.cwd} className="flex items-center gap-3 px-3 py-2">
                <FolderTree size={15} className="shrink-0 text-text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-text">{wt.name}
                    <span className="ml-2 font-mono text-xs text-text-faint">{wt.branch}</span>
                  </div>
                  <div className="truncate text-[11px] text-text-faint" title={wt.cwd}>
                    {wt.repoRoot.split("/").pop()}
                    {wt.branchChanges && <> · <span className="text-success">+{wt.branchChanges.additions}</span> <span className="text-danger">−{wt.branchChanges.deletions}</span></>}
                  </div>
                </div>
                <button type="button" disabled={!!busy} onClick={() => void remove(wt)} title="Remove worktree" aria-label={`Remove worktree ${wt.name}`}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40">
                  {busy === wt.cwd ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              </li>
            ))}
          </ul>
        )}
        {note && <p role="status" className="text-xs text-text-muted">{note}</p>}
      </CardBody>
    </Card>
  );
}
