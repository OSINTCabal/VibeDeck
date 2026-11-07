import * as React from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Boxes, RefreshCw } from "lucide-react";
import { getMcp } from "@/lib/api";
import { Button, Card, CardBody, Badge, Spinner } from "@/components/ui";
import type { McpServerInfo } from "@/lib/types";

export function McpView({ embedded = false, onManageWeb }: { embedded?: boolean; onManageWeb?: () => void }) {
  const [servers, setServers] = React.useState<McpServerInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [revision, setRevision] = React.useState(0);

  React.useEffect(() => {
    let closed = false;
    setLoading(true);
    setError(null);
    getMcp()
      .then((d) => {
        if (closed) return;
        setServers(d.servers);
        setError(null);
      })
      .catch((e) => {
        if (closed) return;
        setServers([]);
        setError(String(e));
      })
      .finally(() => {
        if (!closed) setLoading(false);
      });
    return () => { closed = true; };
  }, [revision]);

  const retry = () => setRevision((r) => r + 1);

  return (
    <section aria-label="Local CLI connectors" className={embedded ? "mt-8 border-t border-border pt-6" : "h-full w-full overflow-y-auto px-6 py-6"}>
      <div className="flex items-center gap-2 mb-1">
        <Boxes size={16} className="text-primary" />
        <h2 className="text-base font-semibold">MCP Servers</h2>
        <Button variant="ghost" size="sm" className="ml-auto" aria-label="Refresh local CLI connectors" disabled={loading} onClick={retry}><RefreshCw size={14} />Refresh</Button>
      </div>
      <p className="text-xs text-text-muted mb-4">
        Configured in <code className="font-mono">~/.vibe/config.toml</code> under <code className="font-mono">[[mcp_servers]]</code>.
      </p>
      <p className="mb-4 text-xs text-text-muted">Local CLI connectors. The desktop and CLI share this configuration for new sessions. Listed servers are configured, not connection-tested. Web connectors use separate authorization. <Link className="text-primary hover:underline" to="/workspace/connectors" onClick={onManageWeb}>Manage web connectors</Link></p>
      {loading && (
        <div className="text-text-muted text-sm flex items-center gap-2">
          <Spinner /> Loading…
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mb-4 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <AlertTriangle size={13} className="shrink-0" />
          <span className="flex-1 min-w-0 truncate">
            Could not load MCP servers: {error}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={retry}
            disabled={loading}
            aria-label="Retry loading MCP servers"
          >
            <RefreshCw size={12} /> Retry
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {servers.map((s) => (
          <Card key={s.name}>
            <CardBody>
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium font-mono">{s.name}</span>
                <Badge tone="info">{s.transport || "stdio"}</Badge>
              </div>
              {s.command && <div className="text-xs text-text-faint font-mono truncate">cmd: {s.command}</div>}
              {s.url && <div className="text-xs text-text-faint font-mono truncate">url: {s.url}</div>}
            </CardBody>
          </Card>
        ))}
        {!loading && !error && servers.length === 0 && (
          <div className="text-text-faint text-sm">No MCP servers configured. Add one in <code className="font-mono">~/.vibe/config.toml</code>.</div>
        )}
      </div>
    </section>
  );
}
