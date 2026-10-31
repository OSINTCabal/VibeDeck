import * as React from "react";
import { Link } from "react-router-dom";
import { getSkills, setSharedSkills } from "@/lib/api";
import { Button, Card, CardBody, Badge, Spinner, Input } from "@/components/ui";
import { Puzzle, RefreshCw } from "lucide-react";
import type { SkillInfo } from "@/lib/types";
import { SkillRegistry } from "@/components/SkillRegistry";

export function SkillsView() {
  const [skills, setSkills] = React.useState<SkillInfo[]>([]);
  const [dir, setDir] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [shared, setShared] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [q, setQ] = React.useState("");
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    let closed = false;
    setLoading(true); setError("");
    getSkills().then((d) => {
      if (closed) return;
      setSkills(d.skills); setDir(d.dir); setShared(d.sharedEnabled);
    }).catch(() => {
      if (closed) return;
      setSkills([]); setError("Could not load CLI skills. Check your Vibe configuration and retry.");
    }).finally(() => { if (!closed) setLoading(false); });
    return () => { closed = true; };
  }, [revision]);
  const filtered = skills.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="flex items-center gap-2 mb-1">
        <Puzzle size={16} className="text-primary" />
        <h2 className="text-base font-semibold">Skills</h2>
        <Button variant="ghost" size="sm" className="ml-auto" aria-label={error ? "Retry loading skills" : "Refresh skills"} disabled={loading || saving} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />{error ? "Retry" : "Refresh"}</Button>
      </div>
      <p className="text-xs text-text-muted mb-4">
        Skills the agent can load — managed in <code className="font-mono">{dir}</code>
      </p>
      <div className="mb-5 rounded-lg border border-border p-4 space-y-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shared} disabled={loading || saving || !!error} onChange={async event => {
          const enabled = event.target.checked;
          setSaving(true); setError(""); setShared(enabled);
          try { await setSharedSkills(enabled); setShared(enabled); }
          catch { setShared(!enabled); setError("Could not save shared skills. Choose Retry to reload the current setting."); }
          finally { setSaving(false); }
        }} />Use shared Mistral workspace skills in the CLI and desktop</label>
        <p className="text-xs text-text-muted">Uses Vibe’s experimental skill registry with your Mistral API credentials. Applies to new sessions in both apps. Google sign-in alone does not authorize the CLI registry. Local skills stay on this device.</p>
        <Link to="/workspace/skills" className="inline-block text-sm text-primary hover:underline">Manage web workspace skills</Link>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <SkillRegistry />
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter skills…" className="max-w-sm mb-4" />
      {loading && <div className="text-text-muted text-sm flex items-center gap-2"><Spinner /> Loading…</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((s) => (
          <Card key={s.name}>
            <CardBody>
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium">{s.name}</span>
                <Badge>skill</Badge>
              </div>
              <div className="text-xs text-text-faint font-mono truncate">{s.path}</div>
            </CardBody>
          </Card>
        ))}
        {!loading && !error && filtered.length === 0 && <div className="text-text-faint text-sm">{q ? "No matching skills." : "No skills found."}</div>}
      </div>
    </div>
  );
}
