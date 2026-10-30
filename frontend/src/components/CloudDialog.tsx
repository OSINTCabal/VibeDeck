import * as React from "react";
import { Check, CircleAlert, Cloud, ExternalLink, GitBranch, Loader2, Plus } from "lucide-react";
import { Button, Dialog } from "./ui";
import { cn } from "@/lib/utils";
import {
  cloudCancel, cloudCreate, cloudMore, cloudOpen, cloudSelect, cloudTeleport, cloudTeleportCancel,
  cloudTeleportPush, cloudTeleportStatus, type CloudPickerView, type TeleportStatus,
} from "@/lib/api";

const STEPS: { kind: string; label: string }[] = [
  { kind: "summarizing_context", label: "Summarizing the conversation" },
  { kind: "checking_git", label: "Checking the git branch" },
  { kind: "pushing", label: "Pushing to GitHub" },
  { kind: "starting_workflow", label: "Starting the cloud session" },
  { kind: "complete", label: "Ready on Vibe Code" },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * "Continue in cloud": moves this session to Vibe Code Web through the vibe
 * app-server's teleport. The user picks (or creates) the Vibe Code project for
 * the repository, approves any push, and gets a link to the cloud session.
 */
export function CloudDialog({ sessionId, open, onClose }: { sessionId: string; open: boolean; onClose: () => void }) {
  const [phase, setPhase] = React.useState<"loading" | "pick" | "running" | "error">("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [pickerId, setPickerId] = React.useState<string | null>(null);
  const [view, setView] = React.useState<CloudPickerView | null>(null);
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [op, setOp] = React.useState<TeleportStatus | null>(null);
  const pickerRef = React.useRef<string | null>(null);
  const opRef = React.useRef<TeleportStatus | null>(null);
  opRef.current = op;

  React.useEffect(() => {
    if (!open) return;
    let closed = false;
    setPhase("loading"); setError(null); setOp(null); setView(null); setProjectId(null);
    setCreating(false); setPrompt(""); pickerRef.current = null;
    cloudOpen(sessionId).then(d => {
      if (closed) { void cloudCancel(sessionId, d.pickerId).catch(() => {}); return; }
      pickerRef.current = d.pickerId;
      setPickerId(d.pickerId);
      setView(d.view);
      setNewName(d.view.context.repoName.split("/").pop() || d.view.context.repoName);
      setProjectId(d.resolvedProjectId || d.view.context.savedLink?.projectId || null);
      setPhase("pick");
    }).catch(e => { if (!closed) { setError(message(e)); setPhase("error"); } });
    return () => { closed = true; };
  }, [open, sessionId]);

  // poll the operation until it finishes
  React.useEffect(() => {
    if (!op || op.done) return;
    const timer = setInterval(() => {
      cloudTeleportStatus(sessionId, op.operationId).then(setOp).catch(() => {});
    }, 700);
    return () => clearInterval(timer);
  }, [sessionId, op?.operationId, op?.done]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    const running = opRef.current;
    if (running && !running.done) void cloudTeleportCancel(sessionId, running.operationId).catch(() => {});
    else if (!running && pickerRef.current) void cloudCancel(sessionId, pickerRef.current).catch(() => {});
    pickerRef.current = null;
    onClose();
  };

  const linked = (repos: { repoUrl: string }[]) => !view || repos.some(r => r.repoUrl === view.context.repoUrl);
  const projects = view?.state.projects || [];
  const defaultBranch = view?.git.defaultBranch || view?.git.branch || "main";

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const start = () => run(async () => {
    if (!pickerId) return;
    let id = projectId;
    if (creating) {
      const created = await cloudCreate(sessionId, pickerId, newName.trim(), defaultBranch);
      setView(created.view);
      id = created.project.projectId;
    } else if (id && id !== view?.context.savedLink?.projectId) {
      await cloudSelect(sessionId, pickerId, id);
    }
    if (!id) throw new Error("Choose a Vibe Code project first.");
    setOp(await cloudTeleport(sessionId, pickerId, id, prompt.trim() || undefined));
    pickerRef.current = null;
    setPhase("running");
  });
  const respond = (approved: boolean) => run(async () => {
    if (op) setOp(await cloudTeleportPush(sessionId, op.operationId, approved));
  });

  const activeStep = op && !op.done ? op.status : null;
  // steps the flow skipped (no push needed) count as done once a later one is reached
  const furthest = Math.max(-1, ...(op?.events || []).map(e => STEPS.findIndex(s => s.kind === e.kind)));

  return (
    <Dialog open={open} onClose={close} title="Continue in cloud" className="max-w-md">
      {phase === "loading" && (
        <p className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Checking this repository…</p>
      )}

      {phase === "error" && (
        <div className="space-y-3">
          <p role="alert" className="flex gap-2 text-sm text-danger"><CircleAlert size={16} className="mt-0.5 shrink-0" />{error}</p>
          <p className="text-xs text-text-muted">Cloud sessions need a git repository with a GitHub remote, a Mistral model, a Vibe or workspace API key, and GitHub connected to your Mistral account.</p>
        </div>
      )}

      {phase === "pick" && view && (
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            The conversation moves to Vibe Code on the web, where it keeps working on{" "}
            <span className="font-mono text-text">{view.git.repo}</span>
            {view.git.branch && <> at <span className="inline-flex items-center gap-0.5 font-mono text-text"><GitBranch size={11} />{view.git.branch}</span></>}.
            Unpushed commits are pushed only after you approve.
          </p>
          <div>
            <div className="mb-1.5 text-xs font-medium text-text-muted">Vibe Code project</div>
            <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
              {projects.map(p => {
                const usable = linked(p.repositories) && !p.isReadOnly;
                const active = !creating && projectId === p.projectId;
                return (
                  <button key={p.projectId} type="button" disabled={!usable || busy}
                    onClick={() => { setCreating(false); setProjectId(p.projectId); }}
                    title={usable ? undefined : "This project is not linked to this repository"}
                    className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:opacity-40",
                      active ? "bg-surface-muted" : "hover:bg-surface-muted/60")}>
                    <Check size={13} className={cn("shrink-0", active ? "text-primary" : "opacity-0")} />
                    <span className="truncate">{p.name}</span>
                  </button>
                );
              })}
              {view.state.nextCursor && (
                <button type="button" disabled={busy} onClick={() => void run(async () => { if (pickerId) setView((await cloudMore(sessionId, pickerId)).view); })}
                  className="w-full px-3 py-2 text-left text-xs text-primary hover:bg-surface-muted/60 transition-colors">Load more projects</button>
              )}
              <button type="button" disabled={busy} onClick={() => setCreating(true)}
                className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors", creating ? "bg-surface-muted" : "hover:bg-surface-muted/60")}>
                <Plus size={13} className={cn("shrink-0", creating && "text-primary")} /> New project for this repository
              </button>
            </div>
            {creating && (
              <input value={newName} onChange={e => setNewName(e.target.value)} aria-label="New project name" placeholder="Project name"
                className="mt-2 h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-border-strong" />
            )}
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-text-muted">Instructions for the cloud agent (optional)</span>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={2} placeholder="e.g. Finish the refactor and open a pull request"
              className="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-faint focus:outline-none focus:border-border-strong" />
          </label>
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={busy || (creating ? !newName.trim() : !projectId)} onClick={() => void start()}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Cloud size={13} />} Continue in cloud
            </Button>
          </div>
        </div>
      )}

      {phase === "running" && op && (
        <div className="space-y-4">
          <ol className="space-y-2">
            {STEPS.map((step, i) => {
              const done = (i < furthest || (i === furthest && step.kind !== activeStep));
              const current = step.kind === activeStep || (activeStep === "push_required" && step.kind === "pushing");
              return (
                <li key={step.kind} className={cn("flex items-center gap-2 text-sm", done || current ? "text-text" : "text-text-faint")}>
                  {done ? <Check size={14} className="shrink-0 text-success" />
                    : current ? <Loader2 size={14} className="shrink-0 animate-spin text-primary" />
                    : <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-border-strong" />}
                  {step.label}
                </li>
              );
            })}
          </ol>
          {op.push && (
            <div className="rounded-lg border border-border bg-surface p-3">
              <p className="text-sm text-text">
                {op.push.branchNotPushed ? "This branch isn’t on GitHub yet." : `${op.push.unpushedCount} commit${op.push.unpushedCount === 1 ? "" : "s"} aren’t on GitHub yet.`}
              </p>
              <p className="mt-1 text-xs text-text-muted">The cloud session starts from GitHub, so they need to be pushed first.</p>
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void respond(false)}>Don’t push</Button>
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void respond(true)}>Push and continue</Button>
              </div>
            </div>
          )}
          {op.status === "failed" && <p role="alert" className="text-sm text-danger">{op.error}</p>}
          {op.status === "cancelled" && <p className="text-sm text-text-muted">Teleport cancelled. The session stays here.</p>}
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            {op.url ? (
              <a href={op.url} target="_blank" rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm text-primary-foreground transition-opacity hover:opacity-90">
                Open in Vibe Code <ExternalLink size={13} />
              </a>
            ) : !op.done && (
              <Button variant="ghost" size="sm" onClick={close}>Cancel teleport</Button>
            )}
            {op.done && <Button variant="ghost" size="sm" onClick={close}>Close</Button>}
          </div>
        </div>
      )}
    </Dialog>
  );
}
