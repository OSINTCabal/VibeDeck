import * as React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, RefreshCw } from "lucide-react";
import { getUsage } from "@/lib/api";
import { cn, formatTokens, modelLabel } from "@/lib/utils";
import type { UsageAllowance, UsageSnapshot } from "@/lib/types";
import { useVibeModels } from "./Pickers";
import "@/lib/windowControls";

// ---------------------------------------------------------------- allowance snapshot (shared app-wide)

interface Summary { allowances: UsageAllowance[]; status: string | null; plan: string | null; measuredAt: string | null }

let summaryCache: Summary | null = null;
let summaryPromise: Promise<Summary> | null = null;

async function loadSummary(refresh: boolean): Promise<Summary> {
  const now = new Date();
  const year = now.getUTCFullYear(), month = now.getUTCMonth() + 1;
  const desktop = window.vibedeck?.usage;
  const [server, web] = await Promise.allSettled([
    getUsage(year, month, false),
    desktop ? desktop.read(year, month, refresh) : Promise.resolve(null),
  ]);
  const s = server.status === "fulfilled" ? server.value : null;
  const w: UsageSnapshot | null = web.status === "fulfilled" ? web.value : null;
  return {
    allowances: w?.allowances?.length ? w.allowances : s?.allowances || [],
    status: w?.status || s?.status || null,
    plan: s?.account?.plan || null,
    measuredAt: w?.measuredAt || s?.measuredAt || null,
  };
}

function useUsageSummary(open: boolean) {
  const [summary, setSummary] = React.useState<Summary | null>(summaryCache);
  const [loading, setLoading] = React.useState(false);
  const fetchSummary = React.useCallback((refresh: boolean) => {
    if (!summaryPromise) {
      setLoading(true);
      summaryPromise = loadSummary(refresh)
        .then(s => { summaryCache = s; return s; })
        .finally(() => { summaryPromise = null; });
    }
    summaryPromise.then(setSummary).catch(() => {}).finally(() => setLoading(false));
  }, []);
  React.useEffect(() => {
    if (!summaryCache) fetchSummary(false);
    const refresh = () => { if (!document.hidden) fetchSummary(false); };
    const timer = setInterval(refresh, 5 * 60_000);
    window.addEventListener("vibedeck:usage-refresh", refresh);
    window.addEventListener("vibedeck:account-changed", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("vibedeck:usage-refresh", refresh);
      window.removeEventListener("vibedeck:account-changed", refresh);
    };
  }, [fetchSummary]);
  React.useEffect(() => { if (open) fetchSummary(true); }, [open, fetchSummary]);
  return { summary, loading, refresh: () => fetchSummary(true) };
}

// ---------------------------------------------------------------- formatting

function resetLabel(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const at = new Date(value);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (at.getTime() - Date.now() < 24 * 3600_000 && at.getDate() === new Date().getDate()) return `Resets ${time}`;
  const days = (at.getTime() - Date.now()) / (24 * 3600_000);
  if (days < 7) return `Resets ${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `Resets ${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

function money(amount: number | null, currency: string | null): string | null {
  if (amount == null || !currency) return null;
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount); }
  catch { return `${amount.toFixed(2)} ${currency}`; }
}

function Bar({ percent, label }: { percent: number; label: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}
      className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-muted">
      <div className={cn("h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
        p >= 90 ? "bg-danger" : p >= 70 ? "bg-accent" : "bg-primary")} style={{ width: `${p}%` }} />
    </div>
  );
}

function Ring({ percent, spinning }: { percent: number | null; spinning: boolean }) {
  const r = 6.5, c = 2 * Math.PI * r;
  const p = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <svg viewBox="0 0 16 16" className={cn("h-4 w-4 -rotate-90", spinning && percent == null && "animate-spin")} aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-border-strong" />
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={percent == null ? c * 0.75 : c * (1 - p / 100)}
        className={cn("transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none",
          percent == null ? "stroke-text-faint" : p >= 90 ? "stroke-danger" : p >= 70 ? "stroke-accent" : "stroke-primary")} />
    </svg>
  );
}

// ---------------------------------------------------------------- UsageMeter

/**
 * Claude-style usage ring next to the model chip: plan allowances from the
 * connected Mistral account, plus the current session's context window.
 */
export function UsageMeter({
  model, contextTokens, sessionTokens,
}: {
  model: string;
  contextTokens?: number | null;
  sessionTokens?: number | null;
}) {
  const [open, setOpen] = React.useState(false);
  const { summary, loading, refresh } = useUsageSummary(open);
  const { models } = useVibeModels();
  const info = models.find(m => m.id === model);
  const contextLimit = info?.maxContextLength || null;
  const contextPercent = contextTokens && contextLimit ? contextTokens / contextLimit * 100 : null;

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const allowances = summary?.allowances || [];
  // Vibe Code is the allowance sessions draw from; other budgets (included API
  // credit) are shown below it but never drive the ring.
  const primary = allowances.find(a => a.id === "vibe_budget") || allowances[0] || null;
  const secondary = allowances.filter(a => a !== primary);
  const ringPercent = primary?.usedPercent ?? contextPercent;
  const connected = summary?.status && ["ready", "partial", "stale"].includes(summary.status);
  const title = primary ? `${primary.label} ${Math.round(primary.usedPercent)}%` : contextPercent != null ? `Context ${Math.round(contextPercent)}%` : "Usage limits";

  React.useEffect(() => {
    window.vibedeck?.tray?.setUsage(primary ? { label: primary.label, percent: primary.usedPercent } : null).catch(() => {});
  }, [primary?.label, primary?.usedPercent]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title={title}
        aria-label="Usage limits"
        aria-expanded={open}
        className="h-7 w-7 shrink-0 grid place-items-center rounded-lg hover:bg-surface-muted transition-colors"
      >
        <Ring percent={ringPercent} spinning={loading && !summary} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-full mb-2 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface-raised p-4 shadow-2xl animate-slide-up">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-text">Plan usage limits</p>
                {summary?.plan && <p className="text-xs text-text-faint">{summary.plan}</p>}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={refresh} disabled={loading} aria-label="Refresh usage"
                  className="text-text-faint hover:text-text transition-colors disabled:opacity-50">
                  <RefreshCw size={12} className={cn(loading && "animate-spin")} />
                </button>
                <Link to="/usage" onClick={() => setOpen(false)}
                  className="flex items-center gap-1 text-xs text-text-muted hover:text-text transition-colors">
                  View all <ArrowRight size={12} />
                </Link>
              </div>
            </div>

            <div className="mt-3 space-y-3">
              {primary && (() => {
                const used = money(primary.used, primary.currency), limit = money(primary.limit, primary.currency), left = money(primary.remaining, primary.currency);
                const reset = resetLabel(primary.resetAt);
                return (
                  <div>
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="text-text">{primary.label}</span>
                      <span className="text-text-faint">{reset ? `${reset} · ` : ""}{Math.round(primary.usedPercent)}%</span>
                    </div>
                    <Bar percent={primary.usedPercent} label={`${primary.label} used`} />
                    {used && limit && <p className="mt-1 text-[11px] text-text-faint">{used} of {limit}{left ? ` · ${left} left` : ""}</p>}
                  </div>
                );
              })()}
              {secondary.map(a => (
                <div key={a.id} className="flex items-baseline justify-between gap-3 text-[11px] text-text-faint"
                  title={money(a.remaining, a.currency) ? `${money(a.remaining, a.currency)} left` : undefined}>
                  <span>{a.label}</span>
                  <span>{Math.round(a.usedPercent)}% used{money(a.remaining, a.currency) ? ` · ${money(a.remaining, a.currency)} left` : ""}</span>
                </div>
              ))}
              {!allowances.length && (
                <p className="text-xs text-text-muted">
                  {loading && !summary ? "Loading limits…"
                    : connected ? "This account does not report subscription counters."
                    : <>Connect your Mistral account on the <Link to="/usage" onClick={() => setOpen(false)} className="text-primary hover:underline">Usage</Link> page to see plan limits.</>}
                </p>
              )}
            </div>

            {(contextTokens != null || sessionTokens != null) && (
              <div className="mt-4 border-t border-border pt-3 space-y-3">
                {contextTokens != null && (
                  <div>
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="text-text">Context window</span>
                      <span className="font-mono text-text-faint">
                        {formatTokens(contextTokens)}{contextLimit ? ` / ${formatTokens(contextLimit)}` : ""}
                      </span>
                    </div>
                    {contextPercent != null && <Bar percent={contextPercent} label="Context window used" />}
                    <p className="mt-1 text-[11px] text-text-faint">{modelLabel(model, info?.name)}{contextLimit ? " · compacts automatically near the limit" : ""}</p>
                  </div>
                )}
                {sessionTokens != null && sessionTokens > 0 && (
                  <div className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-text">This session</span>
                    <span className="font-mono text-text-faint">{formatTokens(sessionTokens)} tokens</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
