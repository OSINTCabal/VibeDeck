import { SignInConfirmation } from "@/components/SignInConfirmation";
import * as React from "react";
import { BarChart3, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, LogIn, LogOut } from "lucide-react";
import { getUsage } from "@/lib/api";
import { Badge, Button, Card, CardBody, Spinner } from "@/components/ui";
import { cn, formatTokens, modelLabel } from "@/lib/utils";
import type { BillingRow, UsageAllowance, UsageSnapshot } from "@/lib/types";
import "@/lib/windowControls";

const DASHBOARD = "https://admin.mistral.ai/subscription";
const money = (amount: number | null | undefined, currency?: string | null) => {
  if (amount == null || !Number.isFinite(amount) || !currency) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount); }
  catch { return `${amount.toFixed(2)} ${currency}`; }
};
const stamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Unavailable";

export function UsageView() {
  const now = new Date();
  const [period, setPeriod] = React.useState({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
  const [server, setServer] = React.useState<UsageSnapshot | null>(null);
  const [web, setWeb] = React.useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<"account" | "local">("account");
  const [connecting, setConnecting] = React.useState(false);
  const generation = React.useRef(0);
  const busy = React.useRef(false);
  const desktop = window.vibedeck?.usage;

  React.useEffect(() => {
    const changed = () => setPeriod(period => ({ ...period }));
    window.addEventListener("vibedeck:account-changed", changed);
    return () => window.removeEventListener("vibedeck:account-changed", changed);
  }, []);

  React.useEffect(() => {
    let closed = false;
    const token = ++generation.current;
    busy.current = false;
    setLoading(true);
    setServer(null);
    setWeb(null);
    async function load(refresh = false) {
      if (closed || busy.current) return;
      busy.current = true;
      setRefreshing(true);
      const results = await Promise.allSettled([
        getUsage(period.year, period.month, refresh),
        desktop ? desktop.read(period.year, period.month, refresh) : Promise.resolve(null),
      ]);
      if (closed || generation.current !== token) return;
      if (results[0].status === "fulfilled") setServer(results[0].value);
      if (results[1].status === "fulfilled") setWeb(results[1].value);
      const failures = results.filter(r => r.status === "rejected");
      setError(failures.length ? "Some usage data could not be refreshed. Existing figures may be stale." : null);
      setLoading(false);
      setRefreshing(false);
      busy.current = false;
    }
    void load(true);
    const refresh = () => { if (!document.hidden) void load(true); };
    const timer = setInterval(refresh, 60000);
    window.addEventListener("vibedeck:usage-refresh", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => { closed = true; clearInterval(timer); window.removeEventListener("vibedeck:usage-refresh", refresh); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("focus", refresh); };
  }, [period, desktop]);

  const refresh = () => window.dispatchEvent(new Event("vibedeck:usage-refresh"));
  const connect = async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      if (await desktop?.connect()) setPeriod(p => ({ ...p }));
    } catch (e) { setError(String(e)); }
    finally { setConnecting(false); }
  };
  const disconnect = async () => {
    try {
      await desktop?.disconnect();
      generation.current++;
      busy.current = false;
      setWeb({ status: "disconnected", source: "web", allowances: [], billing: null });
      // Changing the period object reruns the reader and invalidates pending account requests.
      window.dispatchEvent(new Event("vibedeck:account-changed"));
    } catch (e) { setError(String(e)); }
  };
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(period.year, period.month - 1 + delta, 1));
    setPeriod({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  };
  const allowances = web?.allowances || [];
  const billing = server?.billing && server.billing.status !== "stale" ? server.billing : web?.billing || server?.billing;
  const rows = server?.local?.rows || [];
  const localTotals = rows.reduce((a, r) => ({ p: a.p + r.prompt_tokens, c: a.c + r.completion_tokens,
    cached: a.cached + r.cached_tokens, cost: a.cost + r.estimated_cost_usd }), { p: 0, c: 0, cached: 0, cost: 0 });
  const connected = web && ["ready", "partial", "stale"].includes(web.status);
  const currentMonth = period.year === now.getUTCFullYear() && period.month === now.getUTCMonth() + 1;
  const chartRows: BillingRow[] = tab === "account" ? billing?.rows || [] : rows.map(r => ({
    day: r.day, model: r.model || "Unknown model", inputTokens: r.prompt_tokens,
    outputTokens: r.completion_tokens, cachedTokens: r.cached_tokens, cost: r.estimated_cost_usd,
  }));
  const models = new Map<string, { input: number; output: number; cached: number }>();
  for (const row of chartRows) {
    const item = models.get(row.model) || { input: 0, output: 0, cached: 0 };
    item.input += row.inputTokens; item.output += row.outputTokens; item.cached += row.cachedTokens;
    models.set(row.model, item);
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6 md:px-8 md:py-8">
        <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-primary"><BarChart3 size={18} /><span className="text-xs">Account & activity</span></div>
            <h1 className="text-2xl font-medium tracking-tight">Usage</h1>
            <p className="mt-1.5 text-sm text-text-muted">Your subscription allowances, billing, and local Vibe activity.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing} aria-label="Refresh usage"><RefreshCw size={14} className={cn(refreshing && "animate-spin")} /> Refresh</Button>
            <a href={DASHBOARD} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text transition-colors">Open Mistral <ExternalLink size={12} /></a>
          </div>
        </div>
        {error && <p role="alert" className="mb-4 text-sm text-danger">{error}</p>}
        <Card className="mb-5"><CardBody>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">Mistral account</span><Badge tone={connected ? "success" : "default"}>{connected ? "Usage connected" : web?.status === "expired" ? "Sign-in expired" : "Not connected"}</Badge></div>
              <p className="mt-1 text-xs text-text-muted">CLI plan: {server?.account?.plan || (server?.account?.status === "disconnected" ? "Sign in with vibe --setup" : "Unavailable")}</p>
              <p className="mt-1 text-xs text-text-faint">Web usage and Admin billing belong to their signed-in organization. They may differ from your CLI account.</p>
            </div>
            {desktop ? <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={connecting} onClick={() => void connect()}><LogIn size={13} />{connecting ? "Waiting for sign-in…" : connected ? "Manage account" : "Connect usage"}</Button>
              {connected && <Button size="sm" variant="ghost" onClick={() => void disconnect()} aria-label="Disconnect usage"><LogOut size={13} />Disconnect</Button>}
            </div> : <span className="text-xs text-text-muted">Open the Electron desktop app to connect subscription usage.</span>}
          </div>
          {desktop && <p className="mt-3 text-xs text-text-muted">Choose Google or email on Mistral’s sign-in page in the browser window, then “I’ve signed in” in VibeDeck. Usage stays connected in the background and refreshes every minute while this page is visible. Mistral may take time to report new usage.</p>}
          {web?.detail && <p className="mt-3 text-xs text-text-muted">{web.detail}</p>}
          {web?.measuredAt && <p className="mt-2 text-[11px] text-text-faint">Subscription checked {stamp(web.measuredAt)}{web.status === "stale" ? " · Stale data" : ""}</p>}
        </CardBody></Card>

        <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">Current subscription</h2><span className="text-xs text-text-faint">Provider-reported allowances</span></div>
        {connecting && <div className="mb-5"><SignInConfirmation /></div>}
        <div className="mb-7 grid gap-4 md:grid-cols-2">
          {loading ? <Card><CardBody><Spinner /> <span className="ml-2 text-sm text-text-muted">Loading usage…</span></CardBody></Card> : allowances.length ? allowances.map(a => <Allowance key={a.id} value={a} />) : <Card className="md:col-span-2"><CardBody>
            <p className="text-sm text-text-muted">{connected ? "Subscription counters are unavailable for this account." : "Connect your Mistral account to see your included usage and reset date."}</p>
            <p className="mt-2 text-xs text-text-faint">Local token counts cannot determine your remaining subscription allowance.</p>
          </CardBody></Card>}
        </div>

        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border">
          <div className="flex gap-5" role="tablist" aria-label="Usage source">
            {([['account', 'Account usage'], ['local', 'Local activity']] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn("border-b-2 pb-3 text-sm transition-colors", tab === id ? "border-primary text-text" : "border-transparent text-text-muted hover:text-text")}>{label}</button>)}
          </div>
          <div className="mb-2 flex items-center gap-3"><button onClick={() => shift(-1)} aria-label="Previous month" className="text-text-muted hover:text-text transition-colors"><ChevronLeft size={16} /></button><span className="min-w-28 text-center text-xs">{new Date(Date.UTC(period.year, period.month - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</span><button disabled={currentMonth} onClick={() => shift(1)} aria-label="Next month" className="text-text-muted hover:text-text transition-colors disabled:opacity-30"><ChevronRight size={16} /></button></div>
        </div>
        {tab === "account" && !billing ? <Card className="mb-5"><CardBody><p className="text-sm text-text-muted">Connect usage or configure a Mistral Admin API key to read account billing.</p><p className="mt-2 text-xs text-text-faint">{server?.detail}</p></CardBody></Card> : <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label={tab === "account" ? "Reported spend" : "Estimated Vibe cost"} value={tab === "account" ? money(billing?.cost, billing?.currency) : money(localTotals.cost, "USD")} />
            <Metric label="Input tokens" value={formatTokens(tab === "account" ? billing?.inputTokens || 0 : localTotals.p)} />
            <Metric label="Output tokens" value={formatTokens(tab === "account" ? billing?.outputTokens || 0 : localTotals.c)} />
            <Metric label="Cached tokens" value={formatTokens(tab === "account" ? billing?.cachedTokens || 0 : localTotals.cached)} />
          </div>
          {tab === "account" && billing && <p className="mb-4 text-xs text-text-faint">{billing.source === "admin" ? "Organization from your Admin API key" : "Organization from your Mistral web session"} · Updated {stamp(billing.measuredAt)}{billing.status !== "ready" ? ` · ${billing.status}` : ""}{billing.detail ? ` · ${billing.detail}` : ""}</p>}
          {tab === "local" && <p className="mb-4 text-xs text-text-faint">Observed increments while VibeDeck is connected, grouped by observation date in UTC. Earlier CLI activity is not reconstructed. Playground tokens are included; its spend is available through account billing.</p>}
          <Card className="mb-5"><CardBody><h2 className="mb-4 text-sm font-medium">Tokens over time</h2><UsageChart rows={chartRows} /></CardBody></Card>
          <Card><CardBody><h2 className="mb-3 text-sm font-medium">By model</h2><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-border text-xs text-text-faint"><th className="py-2 text-left font-normal">Model</th><th className="text-right font-normal">Input</th><th className="text-right font-normal">Output</th><th className="text-right font-normal">Cached</th></tr></thead><tbody>{[...models].map(([model, value]) => <tr key={model} className="border-b border-border/60 transition-colors hover:bg-surface/40"><td className="py-3 text-xs" title={model}>{modelLabel(model)}</td><td className="text-right">{formatTokens(value.input)}</td><td className="text-right">{formatTokens(value.output)}</td><td className="text-right">{formatTokens(value.cached)}</td></tr>)}{!models.size && <tr><td colSpan={4} className="py-7 text-center text-sm text-text-faint">No recorded activity in this month.</td></tr>}</tbody></table></div></CardBody></Card>
        </>}
      </div>
    </div>
  );
}

function Allowance({ value }: { value: UsageAllowance }) {
  return <Card><CardBody><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{value.label}</h3><span className="font-mono text-sm">{value.usedPercent.toFixed(1)}% used</span></div><div role="progressbar" aria-label={`${value.label} used`} aria-valuenow={Math.min(100, value.usedPercent)} aria-valuemin={0} aria-valuemax={100} className="my-4 h-1.5 overflow-hidden rounded-full bg-surface-muted"><div className={cn("h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none", value.usedPercent >= 90 ? "bg-accent" : "bg-primary")} style={{ width: `${Math.min(100, value.usedPercent)}%` }} /></div><div className="flex justify-between text-xs text-text-muted"><span>{money(value.used, value.currency)} of {money(value.limit, value.currency)}</span><span>{money(value.remaining, value.currency)} left</span></div><p className="mt-3 text-xs text-text-faint">Resets {stamp(value.resetAt)}</p></CardBody></Card>;
}
function Metric({ label, value }: { label: string; value: string }) { return <Card><CardBody><p className="text-xs text-text-muted">{label}</p><p className="mt-2 font-mono text-xl">{value}</p></CardBody></Card>; }
function UsageChart({ rows }: { rows: BillingRow[] }) {
  const days = new Map<string, number>();
  for (const row of rows) if (/^\d{4}-\d{2}-\d{2}$/.test(row.day)) days.set(row.day, (days.get(row.day) || 0) + row.inputTokens + row.outputTokens);
  const values = [...days].sort(([a], [b]) => a.localeCompare(b));
  const max = Math.max(1, ...values.map(([, count]) => count));
  if (!values.length) return <div className="grid h-40 place-items-center text-sm text-text-faint">No daily usage available.</div>;
  const step = 720 / values.length, width = Math.min(32, step * 0.6);
  return <svg viewBox="0 0 720 170" className="h-44 w-full" role="img" aria-label="Daily input and output token usage"><line x1="0" y1="145" x2="720" y2="145" className="stroke-border" />{values.map(([day, count], i) => { const height = Math.max(0, count / max * 125); return <g key={day}><title>{`${day}: ${formatTokens(count)} tokens`}</title><rect x={i * step + (step - width) / 2} y={145 - height} width={width} height={height} rx="2" className="fill-primary" />{(values.length <= 8 || i % Math.ceil(values.length / 8) === 0) && <text x={i * step + step / 2} y="165" textAnchor="middle" fontSize="10" className="fill-text-faint">{day.slice(5)}</text>}</g>; })}</svg>;
}
