import * as React from "react";
import { studioModels } from "@/lib/api";
import { Badge, Spinner, Input } from "@/components/ui";
import { formatTokens } from "@/lib/utils";
import type { ModelInfo } from "@/lib/types";

export function ModelsView() {
  const [models, setModels] = React.useState<ModelInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [q, setQ] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    studioModels().then((d) => { setModels(d.models); setLoading(false); })
      .catch(() => { setError("Could not load Studio models. Check your Studio API key in Settings → Providers."); setLoading(false); });
  }, []);

  const filtered = models.filter((m) =>
    m.id.toLowerCase().includes(q.toLowerCase()) || m.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border shrink-0">
        <h2 className="text-base font-semibold">Models</h2>
        <span className="text-xs text-text-faint">{filtered.length} available</span>
        <div className="flex-1" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter models…" className="max-w-sm font-mono" />
      </div>
      <div className="flex-1 overflow-y-auto px-6">
        {error && <p role="alert" className="py-4 text-sm text-danger">{error}</p>}
        {loading && <div className="py-6 text-text-muted text-sm flex items-center gap-2"><Spinner /> Loading models…</div>}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-faint border-b border-border">
              <th className="pl-0 pr-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Context</th>
              <th className="px-3 py-2 font-medium">Tools</th>
              <th className="px-3 py-2 font-medium">Vision</th>
              <th className="pl-3 pr-0 py-2 font-medium">Owner</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => (
              <tr key={m.id} className="border-b border-border/60 transition-colors hover:bg-surface/40">
                <td className="pl-0 pr-3 py-2.5">
                  <div className="font-mono text-text">{m.id}</div>
                  {m.description && <div className="text-xs text-text-faint mt-0.5">{m.description}</div>}
                </td>
                <td className="px-3 py-2.5 font-mono text-text-muted">{m.maxContextLength ? formatTokens(m.maxContextLength) : "—"}</td>
                <td className="px-3 py-2.5">{m.functionCalling ? <Badge tone="success">yes</Badge> : <span className="text-text-faint">—</span>}</td>
                <td className="px-3 py-2.5">{m.vision ? <Badge tone="info">yes</Badge> : <span className="text-text-faint">—</span>}</td>
                <td className="pl-3 pr-0 py-2.5 text-text-muted">{m.ownedBy || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !error && filtered.length === 0 && (
          <div className="py-6 text-text-faint text-sm">No models match.</div>
        )}
      </div>
    </div>
  );
}
