import * as React from "react";
import { getAgents } from "@/lib/api";
import { Card, CardBody, Badge, Spinner } from "@/components/ui";
import { Bot } from "lucide-react";
import type { AgentInfo } from "@/lib/types";

export function AgentsView() {
  const [agents, setAgents] = React.useState<AgentInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    getAgents().then((d) => { setAgents(d.agents); setLoading(false); }).catch(() => { setError("Could not load CLI agent profiles. Check the sidecar connection."); setLoading(false); });
  }, []);

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <h2 className="text-base font-semibold mb-1">Agents</h2>
      <p className="text-xs text-text-muted mb-4">
        Agent profiles known to the vibe CLI. <span className="text-text">Modes</span> set the
        session's approval posture; native <span className="text-primary">subagents</span>
        inherit the parent model. To delegate to another provider, ask the main model
        to use VibeDeck’s built-in delegate tool. Configure automatic delegation and quality in Settings → Config → Subagents. Profiles live in{" "}
        <code className="font-mono">~/.vibe/agents/*.toml</code>.
      </p>
      {error && <p role="alert" className="mb-4 text-sm text-danger">{error}</p>}
      {loading && <div className="text-text-muted text-sm flex items-center gap-2"><Spinner /> Loading…</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {agents.map((a) => (
          <Card key={a.name}>
            <CardBody>
              <div className="flex items-center gap-2 mb-1">
                <Bot size={15} className="text-primary" />
                <span className="font-medium">{a.displayName || a.name}</span>
                <Badge tone={a.agentType === "subagent" ? "primary" : "default"}>
                  {a.agentType === "subagent" ? "subagent" : "mode"}
                </Badge>
                {a.safety && a.safety !== "neutral" && <Badge tone="default">{a.safety}</Badge>}
              </div>
              {a.description && (
                <div className="text-xs text-text-muted mb-1.5 line-clamp-2">{a.description}</div>
              )}
              <div className="text-xs text-text-faint font-mono truncate">
                {a.path || a.name}
              </div>
            </CardBody>
          </Card>
        ))}
        {!loading && !error && agents.length === 0 && (
          <div className="text-text-faint text-sm">No agents found.</div>
        )}
      </div>
    </div>
  );
}
