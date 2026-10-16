import * as React from "react";
import { getAudit, listSessions } from "@/lib/api";
import { Card, CardBody, Badge, Button, Spinner } from "@/components/ui";
import { timeAgo } from "@/lib/utils";

export function ObservabilityView() {
  const [audit, setAudit] = React.useState<any[]>([]);
  const [sessions, setSessions] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [auditError, setAuditError] = React.useState(false);
  const [sessionError, setSessionError] = React.useState(false);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let closed = false;
    setLoading(true);
    Promise.allSettled([getAudit(), listSessions()]).then(([a, s]) => {
      if (closed) return;
      setAuditError(a.status === "rejected");
      setSessionError(s.status === "rejected");
      if (a.status === "fulfilled") setAudit(a.value.audit);
      if (s.status === "fulfilled") setSessions(s.value.sessions);
      setLoading(false);
    });
    return () => { closed = true; };
  }, [reload]);

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <h2 className="text-base font-semibold mb-4">Observability</h2>
      {(auditError || sessionError) && <div className="mb-4 flex items-center gap-3">
        <p role="alert" className="text-sm text-danger">Could not load {auditError && sessionError ? "audit and sessions" : auditError ? "audit events" : "sessions"}.</p>
        <Button variant="outline" disabled={loading} onClick={() => setReload(n => n + 1)}>Retry</Button>
      </div>}

      <h3 className="text-sm font-medium mb-2">Session runtime</h3>
      <Card className="mb-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-faint border-b border-border">
                <th className="px-6 py-2 font-medium">Session</th>
                <th className="px-3 py-2 font-medium">Lane</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {!loading && !sessionError && sessions.length === 0 && <tr className="transition-colors hover:bg-surface/40"><td className="px-6 py-4 text-text-faint" colSpan={5}>No sessions.</td></tr>}
              {sessions.map((s: any) => (
                <tr key={s.id} className="border-b border-border/60 transition-colors hover:bg-surface/40">
                  <td className="px-6 py-2 font-mono text-xs text-text-muted">{s.title || s.id.slice(0, 12)}</td>
                  <td className="px-3 py-2"><Badge>{s.lane || "code"}</Badge></td>
                  <td className="px-3 py-2 font-mono text-xs text-text-muted">{s.model}</td>
                  <td className="px-3 py-2"><Badge tone={s.status === "running" ? "primary" : "default"}>{s.status}</Badge></td>
                  <td className="px-3 py-2 text-text-faint">{timeAgo(s.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <h3 className="text-sm font-medium mb-2">Audit trail</h3>
      <Card>
        <CardBody>
          {loading && <div className="text-text-muted text-sm flex items-center gap-2"><Spinner /> Loading…</div>}
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {audit.map((a: any, i: number) => (
              <div key={i} className="flex items-center gap-3 text-xs font-mono">
                <span className="text-text-faint shrink-0">{new Date(a.ts * 1000).toLocaleTimeString()}</span>
                <Badge tone="info">{a.action}</Badge>
                <span className="text-text-muted truncate">{a.detail}</span>
              </div>
            ))}
            {!loading && !auditError && audit.length === 0 && <div className="text-text-faint text-sm">No audit events.</div>}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
