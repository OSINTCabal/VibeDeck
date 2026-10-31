import * as React from "react";
import { Check, ChevronRight, FileDiff, Loader2, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  decideReview, getReviewFile, ownerKey,
  type ReviewFileDiff, type ReviewOwner, type ReviewState, type ReviewStatus, type ReviewTarget,
} from "@/lib/api";

const STATUS: Record<ReviewStatus, { label: string; tone: string }> = {
  modified: { label: "M", tone: "text-accent" },
  created: { label: "A", tone: "text-success" },
  deleted: { label: "D", tone: "text-danger" },
  binary_or_undecodable: { label: "B", tone: "text-text-muted" },
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function pendingFiles(review: ReviewState | null) {
  return (review?.files || []).filter(f => f.regions.some(r => r.decision === "pending"));
}

/** Tab labels in log order: "Turn 1", "Turn 2", "Manual edit 1"… */
function scopeLabels(owners: ReviewOwner[]) {
  let turns = 0, edits = 0;
  return owners.map(o => o.kind === "agent" ? `Turn ${++turns}` : `Manual edit ${++edits}`);
}

/**
 * The agent's pending file changes, from Vibe's checkpoints. Every hunk, file,
 * turn or the whole set can be kept or reverted; reverting writes the file
 * back on disk. Decisions need an idle session.
 */
export function ReviewPanel({ sessionId, review, running, onChange, onClose }: {
  sessionId: string;
  review: ReviewState | null;
  running: boolean;
  onChange: (next: ReviewState) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = React.useState<string>("all");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const scopes = (review?.scopes || []).filter(s => s.files.length > 0);
  const labels = scopeLabels(scopes.map(s => s.owner));
  const owner = scopes.find(s => ownerKey(s.owner) === scope)?.owner;
  React.useEffect(() => { if (scope !== "all" && !owner) setScope("all"); }, [scope, owner]);

  const files = owner
    ? scopes.find(s => ownerKey(s.owner) === scope)!.files.map(f => ({ path: f.path, status: f.status, count: f.regionCount }))
    : pendingFiles(review).map(f => ({ path: f.path, status: f.status, count: f.regions.filter(r => r.decision === "pending").length }));
  const cwd = review?.cwd ? review.cwd.replace(/\/$/, "") + "/" : "";
  const short = (p: string) => (cwd && p.startsWith(cwd) ? p.slice(cwd.length) : p);

  const decide = async (action: "approve" | "revert", target: ReviewTarget) => {
    if (busy || running) return;
    if (action === "revert" && (target.kind === "all" || target.kind === "scope")
      && !window.confirm(`Revert ${target.kind === "all" ? "every pending change" : "this turn's changes"} on disk?`)) return;
    setBusy(true); setError(null);
    try { onChange(await decideReview(sessionId, action, target)); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const whole: ReviewTarget = owner ? { kind: "scope", owner } : { kind: "all" };

  return (
    // docked beside the conversation on wide windows, over it on narrow ones
    <aside aria-label="Changes" className={cn(
      "flex h-full w-[min(560px,48%)] min-w-[320px] shrink-0 flex-col border-l border-border bg-bg",
      "max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(560px,92%)] max-lg:shadow-2xl",
    )}>
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <FileDiff size={16} className="text-text-muted" />
        <span className="text-sm font-medium">Changes</span>
        <span className="text-xs text-text-faint">{files.length} file{files.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Close changes"
          className="grid h-7 w-7 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text">
          <X size={15} />
        </button>
      </div>

      {scopes.length > 0 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-2" role="tablist" aria-label="Change scope">
          {[{ key: "all", label: "All" }, ...scopes.map((s, i) => ({ key: ownerKey(s.owner), label: labels[i] }))].map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={scope === t.key} onClick={() => setScope(t.key)}
              className={cn("h-7 shrink-0 rounded-md px-2.5 text-xs transition-colors",
                scope === t.key ? "bg-surface-muted text-text" : "text-text-muted hover:bg-surface-muted/60 hover:text-text")}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-y border-border px-3 py-2">
          <span className="flex-1 text-xs text-text-muted">
            {running ? "Decisions are available once the turn ends." : owner ? "Changes from this turn" : "Everything not yet kept"}
          </span>
          <DecideButtons disabled={busy || running} onKeep={() => void decide("approve", whole)} onRevert={() => void decide("revert", whole)}
            keepLabel="Keep all" revertLabel="Revert all" />
        </div>
      )}
      {error && <p role="alert" className="shrink-0 px-3 py-2 text-xs text-danger">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!review ? (
          <p className="flex items-center gap-2 p-4 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Loading changes…</p>
        ) : files.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">No pending changes. Files the agent edits show up here to keep or revert.</p>
        ) : files.map(f => (
          <FileChanges key={`${scope}:${f.path}`} sessionId={sessionId} path={f.path} label={short(f.path)} status={f.status}
            count={f.count} owner={owner} disabled={busy || running} version={review} decide={decide} />
        ))}
      </div>
    </aside>
  );
}

function DecideButtons({ disabled, onKeep, onRevert, keepLabel = "Keep", revertLabel = "Revert", compact }: {
  disabled: boolean; onKeep: () => void; onRevert: () => void; keepLabel?: string; revertLabel?: string; compact?: boolean;
}) {
  const btn = cn("inline-flex items-center gap-1 rounded-md transition-colors disabled:opacity-40",
    compact ? "h-6 px-1.5 text-[11px]" : "h-7 px-2 text-xs");
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button type="button" disabled={disabled} onClick={onRevert} className={cn(btn, "text-text-muted hover:bg-danger/10 hover:text-danger")}>
        <Undo2 size={compact ? 11 : 12} /> {revertLabel}
      </button>
      <button type="button" disabled={disabled} onClick={onKeep} className={cn(btn, "text-text-muted hover:bg-success/10 hover:text-success")}>
        <Check size={compact ? 11 : 12} /> {keepLabel}
      </button>
    </span>
  );
}

function FileChanges({ sessionId, path, label, status, count, owner, disabled, version, decide }: {
  sessionId: string; path: string; label: string; status: ReviewStatus; count: number; owner?: ReviewOwner;
  disabled: boolean; version: ReviewState | null;
  decide: (action: "approve" | "revert", target: ReviewTarget) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [diff, setDiff] = React.useState<ReviewFileDiff | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // reload whenever the review changes (a decision, a finished turn)
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    getReviewFile(sessionId, path, owner)
      .then(d => { if (live) setDiff(d); })
      .catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [open, sessionId, path, owner, version]);

  const fileTarget: ReviewTarget = owner ? { kind: "scopeFile", owner, path } : { kind: "file", path };
  const s = STATUS[status] || STATUS.modified;
  const slash = label.lastIndexOf("/");
  const anchors = new Map((diff?.hunks || []).map(h => [h.row, h]));

  return (
    <div className="border-b border-border">
      <div className="group flex items-center gap-1.5 px-2 py-1.5">
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm hover:bg-surface-muted/60">
          <ChevronRight size={14} className={cn("shrink-0 text-text-faint transition-transform", open && "rotate-90")} />
          <span className={cn("w-3 shrink-0 font-mono text-xs font-semibold", s.tone)} title={status}>{s.label}</span>
          <span className="min-w-0 truncate font-mono text-xs" title={path}>
            {slash >= 0 && <span className="text-text-faint">{label.slice(0, slash + 1)}</span>}
            <span className="text-text">{label.slice(slash + 1)}</span>
          </span>
          <span className="shrink-0 text-[11px] text-text-faint">{count}</span>
        </button>
        <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <DecideButtons compact disabled={disabled} onKeep={() => void decide("approve", fileTarget)} onRevert={() => void decide("revert", fileTarget)} />
        </span>
      </div>
      {open && (
        <div className="pb-2">
          {error ? <p role="alert" className="px-4 py-2 text-xs text-danger">{error}</p>
            : !diff ? <p className="flex items-center gap-2 px-4 py-2 text-xs text-text-muted"><Loader2 size={12} className="animate-spin" /> Loading diff…</p>
            : diff.opaque ? <p className="px-4 py-2 text-xs text-text-muted">Binary file. Keep or revert it as a whole.</p>
            : diff.tooLarge ? <p className="px-4 py-2 text-xs text-text-muted">This diff is too large to show here.</p>
            : (
              <div className="overflow-x-auto font-mono text-[11.5px] leading-[18px]">
                {diff.rows.map((row, i) => {
                  const hunk = anchors.get(i);
                  return (
                    <React.Fragment key={i}>
                      {hunk && (
                        <div className="sticky left-0 flex justify-end px-2 py-0.5">
                          <DecideButtons compact disabled={disabled}
                            onKeep={() => void decide("approve", { kind: "regions", path, regions: hunk.regions })}
                            onRevert={() => void decide("revert", { kind: "regions", path, regions: hunk.regions })} />
                        </div>
                      )}
                      <DiffLine row={row} />
                    </React.Fragment>
                  );
                })}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function DiffLine({ row }: { row: ReviewFileDiff["rows"][number] }) {
  if (row.t === "skip") {
    return <div className="bg-surface-muted/40 px-3 text-text-faint">⋯ {row.count} unchanged line{row.count === 1 ? "" : "s"}</div>;
  }
  const old = row.t === "add" ? "" : row.old + 1;
  const now = row.t === "del" ? "" : row.new + 1;
  return (
    <div className={cn("flex w-max min-w-full",
      row.t === "add" && "bg-success/10", row.t === "del" && "bg-danger/10")}>
      <span className="w-10 shrink-0 select-none pr-1 text-right text-text-faint">{old}</span>
      <span className="w-10 shrink-0 select-none pr-2 text-right text-text-faint">{now}</span>
      <span className={cn("w-4 shrink-0 select-none", row.t === "add" ? "text-success" : row.t === "del" ? "text-danger" : "text-text-faint")}>
        {row.t === "add" ? "+" : row.t === "del" ? "−" : " "}
      </span>
      <span className="whitespace-pre pr-4 text-text">{row.text || " "}</span>
    </div>
  );
}
