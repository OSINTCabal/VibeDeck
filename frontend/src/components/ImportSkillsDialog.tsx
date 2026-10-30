import * as React from "react";
import { Check, CircleAlert, FileUp, FolderOpen, Loader2 } from "lucide-react";
import { getImportableSkills, getProjects, importSkills, uploadSkill } from "@/lib/api";
import type { ImportableSkill, ImportableSkills, SkillImportResult } from "@/lib/types";
import { isFrameless, pickDirectory } from "@/lib/windowControls";
import { cn } from "@/lib/utils";
import { Badge, Button, Dialog, Input, menuLabel } from "./ui";

/** Square counterpart of RadioMark for multi-select rows. */
function CheckMark({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden="true" className={cn(
      "grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
      checked ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-bg",
    )}>
      {checked && <Check size={12} strokeWidth={3} />}
    </span>
  );
}

const STATUS: Record<ImportableSkill["status"], { label: string; tone: "success" | "warning" | "danger" } | null> = {
  new: null,
  imported: { label: "Imported", tone: "success" },
  conflict: { label: "Name in use", tone: "warning" },
  invalid: { label: "Can't import", tone: "danger" },
};

/**
 * Lists skills other agents installed (Claude Code, Codex, project folders, a
 * chosen folder or uploaded file) and copies the chosen ones into
 * ~/.vibe/skills. Skills whose name is taken are replaced only after a
 * second, explicit confirmation.
 */
export function ImportSkillsDialog({ open, onClose, onImported }: {
  open: boolean; onClose: () => void; onImported: (result: SkillImportResult) => void;
}) {
  const [data, setData] = React.useState<ImportableSkills | null>(null);
  const [projects, setProjects] = React.useState<string[]>([]);
  const [paths, setPaths] = React.useState<string[]>([]);
  const [home, setHome] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [q, setQ] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async (nextPaths: string[], keep?: Set<string>) => {
    setLoading(true); setError("");
    try {
      const listed = await getProjects().catch(() => null);
      const known = listed?.recent.map(r => r.path) ?? [];
      const next = await getImportableSkills(known, nextPaths);
      setHome(listed?.home ?? ""); setProjects(known); setPaths(nextPaths); setData(next);
      const ids = new Set(next.sources.flatMap(s => s.skills).filter(s => s.status !== "imported" && s.status !== "invalid").map(s => s.id));
      setSelected(new Set([...(keep ?? [])].filter(id => ids.has(id))));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not look for skills.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setQ(""); setConfirming(false); setSelected(new Set());
    void load([]);
  }, [open, load]);

  const all = React.useMemo(() => data?.sources.flatMap(s => s.skills) ?? [], [data]);
  const byId = React.useMemo(() => new Map(all.map(s => [s.id, s])), [all]);
  const chosen = [...selected].map(id => byId.get(id)).filter((s): s is ImportableSkill => !!s);
  const replacing = chosen.filter(s => s.status === "conflict");

  const toggle = (skill: ImportableSkill) => {
    setConfirming(false);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(skill.id)) { next.delete(skill.id); return next; }
      // Two sources can ship the same name; only one of them can be imported.
      for (const id of next) if (byId.get(id)?.name === skill.name) next.delete(id);
      next.add(skill.id);
      return next;
    });
  };

  const chooseFolder = async () => {
    const picked = await pickDirectory();
    if (picked && !paths.includes(picked)) await load([...paths, picked], selected);
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError("");
    try {
      const staged = await uploadSkill(file);
      const fresh = staged.sources.flatMap(s => s.skills).filter(s => s.status === "new").map(s => s.id);
      await load([...paths, staged.path], new Set([...selected, ...fresh]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const run = async () => {
    if (replacing.length && !confirming) { setConfirming(true); return; }
    setBusy(true); setError("");
    try {
      const result = await importSkills({
        items: chosen.map(s => ({ id: s.id, overwrite: s.status === "conflict" })), projects, paths,
      });
      if (result.failed.length) {
        setError(result.failed.map(f => `${f.name ?? "Skill"}: ${f.error}`).join(" · "));
        await load(paths);
      } else {
        onClose();
      }
      if (result.imported.length) onImported(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false); setConfirming(false);
    }
  };

  const tilde = (path: string) => home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path;
  const needle = q.trim().toLowerCase();
  const sources = (data?.sources ?? []).map(source => ({
    ...source,
    skills: source.skills.filter(s => !needle || s.name.includes(needle) || s.description.toLowerCase().includes(needle)),
  })).filter(source => source.skills.length || !needle);

  return (
    <Dialog open={open} onClose={busy ? () => {} : onClose} title="Import skills" className="max-w-2xl">
      <p className="mb-3 text-sm text-text-muted">
        Copy skills installed for Claude Code, Codex and your projects into <code className="font-mono text-xs">{data ? tilde(data.dest) : "~/.vibe/skills"}</code>.
      </p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter skills…" className="h-8 min-w-40 flex-1" aria-label="Filter importable skills" />
        {isFrameless() && <Button variant="outline" size="sm" onClick={chooseFolder} disabled={loading || busy}><FolderOpen size={14} />Folder…</Button>}
        <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={loading || busy}><FileUp size={14} />SKILL.md or .zip…</Button>
        <input ref={fileInput} type="file" accept=".md,.zip,text/markdown,application/zip" className="hidden" onChange={e => void upload(e.target.files?.[0])} />
      </div>

      <div className="-mx-1 max-h-[52vh] min-h-40 overflow-y-auto rounded-lg border border-border bg-surface p-1">
        {loading && !data && <p className="flex items-center gap-2 px-3 py-3 text-sm text-text-muted"><Loader2 size={14} className="animate-spin" /> Looking for skills…</p>}
        {data && !sources.length && (
          <p className="px-3 py-3 text-sm text-text-faint">{needle ? "No matching skills." : "No skills from other agents were found. Choose a folder or a file instead."}</p>
        )}
        {sources.map(source => (
          <section key={source.id} aria-label={source.label} className="pb-1">
            <div className={cn(menuLabel, "flex items-baseline gap-2")}>
              <span className="text-text-muted">{source.label}</span>
              <span className="truncate font-mono font-normal" title={source.root}>{tilde(source.root)}</span>
            </div>
            {source.note && <p className="px-3 pb-1 text-xs text-text-faint">{source.note}</p>}
            {!source.skills.length && <p className="px-3 py-2 text-sm text-text-faint">No SKILL.md found here.</p>}
            {source.skills.map(skill => {
              const disabled = skill.status === "imported" || skill.status === "invalid" || busy;
              const checked = selected.has(skill.id);
              const status = STATUS[skill.status];
              return (
                <button
                  key={skill.id} type="button" role="checkbox" aria-checked={checked} disabled={disabled}
                  onClick={() => toggle(skill)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-none",
                    disabled && "cursor-default opacity-60 hover:bg-transparent",
                  )}
                >
                  <span className="pt-0.5"><CheckMark checked={checked} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-text">{skill.name || skill.dirName}</span>
                      {status && <Badge tone={status.tone}>{status.label}</Badge>}
                      {skill.converted && skill.status !== "invalid" && <Badge tone="info" className="font-normal">Frontmatter adjusted</Badge>}
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-xs text-text-muted">{skill.error ?? skill.description}</span>
                    {checked && skill.status === "conflict" && (
                      <span className="mt-1 block text-xs text-warning">Replaces the existing {skill.name} in your Vibe skills.</span>
                    )}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>

      {error && <p role="alert" className="mt-3 flex gap-2 text-sm text-danger"><CircleAlert size={16} className="mt-0.5 shrink-0" />{error}</p>}
      {confirming && (
        <p role="alert" className="mt-3 text-sm text-warning">
          {replacing.length === 1 ? `${replacing[0].name} already exists` : `${replacing.length} skills already exist`} in your Vibe skills. Replace {replacing.length === 1 ? "it" : "them"}?
        </p>
      )}
      <div className="mt-4 flex items-center gap-2">
        <span className="text-xs text-text-faint">{chosen.length ? `${chosen.length} selected` : "Nothing selected"}</span>
        <Button variant="ghost" className="ml-auto" onClick={confirming ? () => setConfirming(false) : onClose} disabled={busy}>{confirming ? "Back" : "Cancel"}</Button>
        <Button variant="primary" onClick={run} disabled={busy || loading || !chosen.length}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {confirming ? `Replace and import ${chosen.length}` : `Import${chosen.length ? ` ${chosen.length}` : ""}`}
        </Button>
      </div>
    </Dialog>
  );
}
