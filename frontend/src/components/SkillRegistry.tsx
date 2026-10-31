import * as React from "react";
import { ArrowUpCircle, Check, Download, Library, Trash2 } from "lucide-react";
import { Badge, Button, Spinner } from "./ui";
import { cn } from "@/lib/utils";
import { getSkillRegistry, installSkill, removeSkill, setSkillEnabled, updateSkill, type SkillRegistry as Registry } from "@/lib/api";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Skills from the account's Vibe registry: install, update to the latest
 * version, switch off or remove. Applies to new sessions in VibeDeck and the CLI.
 */
export function SkillRegistry() {
  const [data, setData] = React.useState<Registry | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    getSkillRegistry().then(setData).catch(e => { setError(message(e)); setData(d => d ?? { catalog: [], updates: {}, authenticated: true, installed: [] }); });
  }, []);
  React.useEffect(load, [load]);

  const act = async (key: string, fn: () => Promise<Registry>) => {
    setBusy(key); setError(null);
    try { setData(await fn()); } catch (e) { setError(message(e)); } finally { setBusy(null); }
  };

  const installed = new Map((data?.installed || []).map(s => [s.name, s]));
  const updates = Object.keys(data?.updates || {}).length;

  return (
    <section aria-label="Skill registry" className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <Library size={15} className="text-primary" />
        <h2 className="text-sm font-semibold">From your Vibe registry</h2>
        {updates > 0 && <Badge tone="warning">{updates} update{updates === 1 ? "" : "s"}</Badge>}
      </div>
      {error && <p role="alert" className="mb-2 text-xs text-danger">{error}</p>}
      {!data ? <p className="flex items-center gap-2 text-xs text-text-muted"><Spinner /> Loading the registry…</p>
        : !data.authenticated ? <p className="text-xs text-text-muted">Sign in to Mistral (Settings → Providers) to browse your workspace’s skills.</p>
        : !data.catalog.length ? <p className="text-xs text-text-muted">Your registry has no skills yet.</p>
        : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.catalog.map(skill => {
              const local = installed.get(skill.name);
              const update = data.updates[skill.name];
              const rowBusy = busy?.endsWith(`:${skill.name}`) || busy === `install:${skill.skillId}`;
              return (
                <li key={skill.skillId} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={cn("truncate text-sm", local && !local.enabled ? "text-text-muted" : "text-text")}>{skill.name}</span>
                      {local && <span className="text-[11px] text-text-faint">{local.version ? `v${local.version}` : "installed"}{local.enabled ? "" : " · off"}</span>}
                    </div>
                    <p className="truncate text-[11px] text-text-faint" title={skill.description}>{skill.description}</p>
                  </div>
                  {rowBusy && <Spinner />}
                  {!local ? (
                    <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void act(`install:${skill.skillId}`, () => installSkill(skill.skillId))}>
                      <Download size={12} />Install
                    </Button>
                  ) : (
                    <>
                      {update && (
                        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void act(`update:${skill.name}`, () => updateSkill(skill.name))}>
                          <ArrowUpCircle size={12} />Update to v{update}
                        </Button>
                      )}
                      <button type="button" disabled={!!busy} onClick={() => void act(`enabled:${skill.name}`, () => setSkillEnabled(skill.name, !local.enabled))}
                        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-muted hover:bg-surface-muted hover:text-text disabled:opacity-40">
                        {local.enabled ? <><Check size={12} className="text-success" />On</> : "Off"}
                      </button>
                      {local.source !== "local" && (
                        <button type="button" disabled={!!busy} aria-label={`Remove ${skill.name}`}
                          onClick={() => { if (window.confirm(`Remove the skill ${skill.name}?`)) void act(`remove:${skill.name}`, () => removeSkill(skill.name)); }}
                          className="grid h-7 w-7 place-items-center rounded-md text-text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
