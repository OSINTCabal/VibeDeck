import * as React from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Boxes, ExternalLink, LogIn, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  addMcp, getMcpSources, loginMcp, logoutMcp, refreshMcp, removeMcp, toggleMcp,
  type McpSource, type McpState,
} from "@/lib/api";
import { Badge, Button, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" }> = {
  connected: { label: "Connected", tone: "success" },
  needs_auth: { label: "Sign-in needed", tone: "warning" },
  disabled: { label: "Off", tone: "info" },
  connecting: { label: "Connecting", tone: "info" },
  unavailable: { label: "Unavailable", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
};

/**
 * MCP servers from ~/.vibe/config.toml and the Mistral connectors the account
 * can use, live from Vibe: their status and tools, switched on or off, signed
 * in, added or removed. Changes apply to new sessions and to open ones when
 * they are next idle.
 */
export function McpView({ embedded = false, onManageWeb }: { embedded?: boolean; onManageWeb?: () => void }) {
  const [state, setState] = React.useState<McpState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const load = React.useCallback(() => {
    setError(null);
    getMcpSources().then(setState).catch(e => setError(message(e)));
  }, []);
  React.useEffect(load, [load]);

  const act = async (key: string, fn: () => Promise<McpState | void>) => {
    setBusy(key); setError(null);
    try { const next = await fn(); if (next) setState(next); }
    catch (e) { setError(message(e)); }
    finally { setBusy(null); }
  };
  const signIn = (s: McpSource) => act(`login:${s.name}`, async () => {
    const { url } = await loginMcp(s.name, s.kind);
    if (url) window.open(url, "_blank", "noopener");
    // the status changes once the browser flow completes
    window.setTimeout(load, 4000);
  });

  const sources = state?.sources || [];
  const servers = sources.filter(s => s.kind === "server");
  const connectors = sources.filter(s => s.kind === "connector");

  return (
    <section aria-label="MCP servers and connectors" className={embedded ? "mt-8 border-t border-border pt-6" : "h-full w-full overflow-y-auto px-6 py-6"}>
      <div className="mb-1 flex items-center gap-2">
        <Boxes size={16} className="text-primary" />
        <h2 className="text-base font-semibold">MCP servers and connectors</h2>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setAdding(a => !a)} aria-expanded={adding}><Plus size={14} />Add server</Button>
          <Button variant="ghost" size="sm" aria-label="Refresh MCP servers" disabled={!!busy}
            onClick={() => void act("refresh", refreshMcp)}><RefreshCw size={14} className={cn(busy === "refresh" && "animate-spin")} />Refresh</Button>
        </div>
      </div>
      <p className="mb-4 text-xs text-text-muted">
        What Vibe sessions can use, shared with the CLI. Servers live in <code className="font-mono">~/.vibe/config.toml</code>; connectors come from your Mistral account.{" "}
        <Link className="text-primary hover:underline" to="/workspace/connectors" onClick={onManageWeb}>Manage web connectors</Link>
      </p>
      {adding && <AddServer busy={busy === "add"} onAdd={body => act("add", async () => { const next = await addMcp(body); setAdding(false); return next; })} />}
      {error && (
        <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertTriangle size={13} className="shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={load}><RefreshCw size={12} /> Retry</Button>
        </div>
      )}
      {!state && !error && <div className="flex items-center gap-2 text-sm text-text-muted"><Spinner /> Loading…</div>}
      {state && (
        <div className="space-y-6">
          <SourceList title="Servers" empty="No MCP servers yet. Add one above, or in ~/.vibe/config.toml."
            items={servers} busy={busy} onToggle={s => void act(`toggle:${s.name}`, () => toggleMcp(s.name, s.kind, s.status !== "disabled"))}
            onSignIn={s => void signIn(s)} onSignOut={s => void act(`logout:${s.name}`, () => logoutMcp(s.name))}
            onRemove={s => { if (window.confirm(`Remove ${s.displayName} from Vibe's configuration?`)) void act(`remove:${s.name}`, () => removeMcp(s.name)); }} />
          <SourceList title="Connectors" empty={state.connectorError || "No connectors are available to this account."}
            items={connectors} busy={busy} onToggle={s => void act(`toggle:${s.name}`, () => toggleMcp(s.name, s.kind, s.status !== "disabled"))}
            onSignIn={s => void signIn(s)} />
          {state.manageConnectorsUrl && (
            <a href={state.manageConnectorsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              More connectors on Mistral <ExternalLink size={11} />
            </a>
          )}
        </div>
      )}
    </section>
  );
}

function SourceList({ title, empty, items, busy, onToggle, onSignIn, onSignOut, onRemove }: {
  title: string; empty: string; items: McpSource[]; busy: string | null;
  onToggle: (s: McpSource) => void; onSignIn: (s: McpSource) => void;
  onSignOut?: (s: McpSource) => void; onRemove?: (s: McpSource) => void;
}) {
  // connected ones first, the rest alphabetically
  const sorted = [...items].sort((a, b) => Number(b.status === "connected") - Number(a.status === "connected") || a.displayName.localeCompare(b.displayName));
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-text-muted">{title} <span className="text-text-faint">{items.length || ""}</span></h3>
      {!items.length ? <p className="text-xs text-text-faint">{empty}</p> : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {sorted.map(s => {
            const status = STATUS[s.status] || { label: s.status, tone: "info" as const };
            const off = s.status === "disabled";
            const rowBusy = !!busy && busy.endsWith(`:${s.name}`);
            return (
              <li key={`${s.kind}:${s.name}`} className="flex items-center gap-3 px-3 py-2">
                {s.kind === "connector" ? <Plug size={15} className="shrink-0 text-text-muted" /> : <Boxes size={15} className="shrink-0 text-text-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn("truncate text-sm", off ? "text-text-muted" : "text-text")}>{s.displayName}</span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <div className="truncate text-[11px] text-text-faint" title={s.error || undefined}>
                    {s.error || [s.name.startsWith("vibedeck_") ? "managed by VibeDeck" : null, s.kind === "server" ? s.transport : null, s.tools.length ? `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {rowBusy && <Spinner />}
                {s.status === "needs_auth" && (
                  <Button variant="outline" size="sm" disabled={!!busy} onClick={() => onSignIn(s)}><LogIn size={12} />Sign in</Button>
                )}
                {onSignOut && s.status === "connected" && s.transport !== "stdio" && (
                  <button type="button" disabled={!!busy} onClick={() => onSignOut(s)} className="text-xs text-text-muted hover:text-text disabled:opacity-40">Sign out</button>
                )}
                <button type="button" role="switch" aria-checked={!off} aria-label={`${off ? "Turn on" : "Turn off"} ${s.displayName}`}
                  disabled={!!busy} onClick={() => onToggle(s)}
                  className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50", off ? "bg-surface-muted" : "bg-primary")}>
                  <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform", off ? "left-0.5" : "left-[18px]")} />
                </button>
                {onRemove && !s.name.startsWith("vibedeck_") && (
                  <button type="button" disabled={!!busy} onClick={() => onRemove(s)} aria-label={`Remove ${s.displayName}`}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40">
                    <Trash2 size={13} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AddServer({ busy, onAdd }: {
  busy: boolean;
  onAdd: (body: { name?: string; transport: string; url?: string; command?: string; args?: string[] }) => void;
}) {
  const [kind, setKind] = React.useState<"remote" | "local">("remote");
  const [name, setName] = React.useState("");
  const [target, setTarget] = React.useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = target.trim();
    if (!value) return;
    if (kind === "remote") onAdd({ name: name.trim() || undefined, transport: "streamable-http", url: value });
    else {
      // split like a shell would for simple commands: "npx -y @scope/server --flag"
      const [command, ...args] = value.match(/"[^"]*"|'[^']*'|\S+/g)!.map(p => p.replace(/^["']|["']$/g, ""));
      onAdd({ name: name.trim() || undefined, transport: "stdio", command, args });
    }
  };
  return (
    <form onSubmit={submit} className="mb-5 space-y-2 rounded-lg border border-border p-3">
      <div className="flex gap-1 text-xs" role="radiogroup" aria-label="Server type">
        {(["remote", "local"] as const).map(k => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
            className={cn("rounded-md px-2 py-1", kind === k ? "bg-surface-muted text-text" : "text-text-muted hover:text-text")}>
            {k === "remote" ? "Remote (URL)" : "Local (command)"}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name (optional)" className="w-40" aria-label="Server name" />
        <Input value={target} onChange={e => setTarget(e.target.value)} className="min-w-[240px] flex-1 font-mono text-xs"
          placeholder={kind === "remote" ? "https://example.com/mcp" : "npx -y @modelcontextprotocol/server-filesystem ~/Documents"}
          aria-label={kind === "remote" ? "Server URL" : "Server command"} />
        <Button type="submit" variant="primary" size="sm" disabled={busy || !target.trim()}>{busy ? <Spinner /> : <Plus size={13} />}Add</Button>
      </div>
      <p className="text-[11px] text-text-faint">Servers that use OAuth show “Sign in” once added.</p>
    </form>
  );
}
