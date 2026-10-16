import * as React from "react";
import { KeyRound, Plus, Trash2, ChevronDown, Plug } from "lucide-react";
import {
  getProviders, upsertProvider, removeProvider,
  setProviderKey, removeProviderKey, upsertProviderModel, removeProviderModel,
} from "@/lib/api";
import { invalidateVibeModels } from "@/components/Pickers";
import { Badge, Button, Input, Select } from "@/components/ui";
import type { ProviderInfo, ProviderModelInfo, ProvidersView } from "@/lib/types";

interface ModelDraft {
  name: string;
  alias: string;
  temperature: string;
}

const API_STYLES = [
  { value: "openai", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "reasoning", label: "Reasoning-compatible" },
];
const BACKENDS = [
  { value: "generic", label: "generic" },
  { value: "mistral", label: "mistral" },
];

function CodexConnection() {
  const [account, setAccount] = React.useState<{installed?: boolean; connected?: boolean; type?: string; plan?: string; detail?: string}>({});
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const refresh = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch('/api/codex/account');
      if (!response.ok) throw new Error('Could not check Codex sign-in');
      setAccount(await response.json());
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  React.useEffect(() => { void refresh(); }, []);
  const login = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch('/api/codex/login', {method: 'POST'});
      const data = await response.json();
      if (!response.ok || !data.authUrl) throw new Error(data.detail || 'Codex login did not return a browser URL');
      setUrl(data.authUrl);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3">
    <p className="text-sm font-medium">Codex / ChatGPT sign-in <Badge tone={account.connected ? 'success' : 'default'}>{account.connected ? `Connected · ${account.type || 'Codex'}` : 'Not connected'}</Badge></p>
    <p className="text-xs text-text-muted">Uses the official Codex CLI login, including Google sign-in in your regular browser. After signing in, save the provider and add models in Settings → Models.</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || account.installed === false} onClick={() => void login()}>Sign in to ChatGPT</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>Refresh sign-in</Button>
      {url && <a className="text-xs text-primary underline self-center" href={url} target="_blank" rel="noreferrer">Continue sign-in in browser</a>}</div>
    {(error || account.detail) && <p role="status" className="text-xs text-text-muted">{error || account.detail}</p>}
  </div>;
}

const LABELS: Record<string, string> = {
  mistral: "Mistral", codex: "Codex / ChatGPT", openai: "OpenAI", claude: "Claude",
  deepseek: "DeepSeek", zai: "Z.ai", minimax: "MiniMax", google: "Google AI Studio", ollama: "Ollama",
};

function ProviderCard({ provider, mode, onChanged }: {
  provider: ProviderInfo; mode: "providers" | "models"; onChanged: (v: ProvidersView) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [keyInput, setKeyInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ text: string; danger?: boolean } | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [newModel, setNewModel] = React.useState<ModelDraft>({ name: "", alias: "", temperature: "" });
  const [catalog, setCatalog] = React.useState<{id: string; name: string}[]>([]);
  const label = LABELS[provider.name] || provider.name;

  const run = async (fn: () => Promise<ProvidersView>, okText?: string) => {
    setBusy(true); setMsg(null);
    try {
      onChanged(await fn());
      if (okText) setMsg({ text: okText });
      return true;
    } catch (e) {
      setMsg({ text: String(e), danger: true });
      return false;
    } finally { setBusy(false); }
  };
  const saveKey = () => {
    const key = keyInput.trim();
    if (!key || !provider.apiKeyEnvVar || busy) return;
    void run(async () => {
      await setProviderKey(provider.name, key);
      setKeyInput("");
      return getProviders();
    }, "Key saved to the system keyring.");
  };
  const checkConnection = async () => {
    setBusy(true); setMsg(null);
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(provider.name)}/catalog`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Connection failed");
      setCatalog(data.models); setAdding(true);
      setMsg({text: `${data.models.length} models available. No completion was generated.`});
    } catch (e) { setMsg({text: String(e), danger: true}); }
    finally { setBusy(false); }
  };
  const addModel = async () => {
    const name = newModel.name.trim(), alias = newModel.alias.trim();
    if (!name || !alias || busy) return;
    const model: Partial<ProviderModelInfo> & { name: string; alias: string } = { name, alias };
    const temperature = Number.parseFloat(newModel.temperature);
    if (Number.isFinite(temperature)) model.temperature = temperature;
    if (await run(() => upsertProviderModel(provider.name, model), `Model '${alias}' added.`)) {
      setNewModel({name: "", alias: "", temperature: ""}); setAdding(false);
    }
  };

  return <section aria-label={`${label} ${mode === "models" ? "models" : "connection"}`} className="rounded-lg border border-border bg-surface overflow-hidden">
    <div className="flex items-center gap-3 px-4 py-4">
      <span aria-hidden="true" className="grid place-items-center h-9 w-9 shrink-0 rounded-md bg-surface-muted text-text-muted"><Plug size={17} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-medium">{label}</h4>{provider.builtin && <Badge>Built-in</Badge>}</div>
        <p className="text-xs text-text-muted mt-1">{provider.models.length} {provider.models.length === 1 ? "model" : "models"}{mode === "providers" && <> · {provider.name === "codex" ? "Uses Codex CLI sign-in" : !provider.apiKeyEnvVar ? "No API key required" : provider.key.present ? "API key available" : "API key needed"}</>}</p>
      </div>
      {mode === "providers" && <Button variant="ghost" size="sm" aria-label={`Manage ${label}`} aria-expanded={expanded} aria-controls={`provider-${provider.name}`} onClick={() => setExpanded(!expanded)}>Manage <ChevronDown size={14} className={expanded ? "rotate-180" : ""} /></Button>}
    </div>
    {mode === "providers" && expanded && <div id={`provider-${provider.name}`} className="border-t border-border p-4 space-y-4">
      {provider.name === "codex" ? <CodexConnection /> : provider.builtin ? <p className="text-sm text-text-muted">Your Mistral CLI login is managed by Vibe. The separate Studio API key is managed below.</p> : provider.apiKeyEnvVar ? <div className="space-y-2">
        <label className="block text-xs font-medium text-text-muted">API key
          <Input type="password" value={keyInput} onChange={e => setKeyInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") saveKey(); }} placeholder={provider.key.present ? "Replace key…" : "Paste API key…"} className="mt-2" autoComplete="off" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" size="sm" disabled={!keyInput.trim() || busy} onClick={saveKey}><KeyRound size={14} />Save key</Button>
          {provider.key.present && <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { await removeProviderKey(provider.name); return getProviders(); }, "Key removed from the keyring.")}>Remove key</Button>}
        </div>
      </div> : <p className="text-sm text-text-muted">This provider connects without an API key.</p>}
      <details className="text-xs text-text-muted">
        <summary className="cursor-pointer py-1">Connection details</summary>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
          <dt>Endpoint</dt><dd className="break-all font-mono">{provider.apiBase}</dd>
          <dt>API format</dt><dd>{provider.apiStyle}</dd>
          {provider.apiKeyEnvVar && <><dt>Key source</dt><dd className="break-all">{provider.key.source || "Not configured"} · {provider.apiKeyEnvVar}</dd></>}
        </dl>
      </details>
      {!provider.builtin && <div className="border-t border-border pt-3">
        {confirming ? <div className="space-y-2">
          <p className="text-xs text-text-muted">Remove this provider, its registered models and its saved key?</p>
          <div className="flex flex-wrap gap-2"><Button variant="danger" size="sm" disabled={busy} onClick={() => void run(() => removeProvider(provider.name))}>Remove provider</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button></div>
        </div> : <Button variant="ghost" size="sm" className="text-danger" onClick={() => setConfirming(true)}><Trash2 size={14} />Remove provider</Button>}
      </div>}
    </div>}
    {mode === "models" && <div className="border-t border-border">
      {provider.models.map(model => <div key={model.alias} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0">
        <div className="min-w-0 flex-1"><p className="text-sm break-words">{model.alias}</p><p className="text-xs text-text-muted font-mono break-all mt-0.5">{model.name}</p></div>
        {!provider.builtin && <Button size="icon" variant="ghost" aria-label={`Remove model ${model.alias}`} disabled={busy} onClick={() => void run(() => removeProviderModel(provider.name, model.alias))}><Trash2 size={14} /></Button>}
      </div>)}
      {!provider.builtin && <div className="p-4 space-y-4">
        <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void checkConnection()}>Load models</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setAdding(true)}><Plus size={14} />Add model</Button></div>
        {adding && <div className="space-y-3">
          {!!catalog.length && <label className="block text-xs font-medium text-text-muted">Available models<Select aria-label="Available models" className="mt-2 w-full" value={newModel.name} onChange={id => setNewModel(m => ({...m, name:id, alias:m.alias || `${provider.name}-${id.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0,40)}`}))} options={[{value:"",label:"Choose a model"}, ...catalog.map(m => ({value:m.id,label:m.name}))]} /></label>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs font-medium text-text-muted">Model ID<Input className="mt-2" value={newModel.name} onChange={e => setNewModel(m => ({...m,name:e.target.value}))} placeholder="Model ID from provider" /></label>
            <label className="text-xs font-medium text-text-muted">Alias<Input className="mt-2" value={newModel.alias} onChange={e => setNewModel(m => ({...m,alias:e.target.value}))} placeholder="Name shown in the model picker" /></label>
          </div>
          <label className="block text-xs font-medium text-text-muted">Temperature (optional)<Input className="mt-2 max-w-40" value={newModel.temperature} onChange={e => setNewModel(m => ({...m,temperature:e.target.value}))} placeholder="Provider default" type="number" step="0.1" /></label>
          <div className="flex flex-wrap gap-2"><Button variant="primary" size="sm" disabled={!newModel.name.trim() || !newModel.alias.trim() || busy} onClick={() => void addModel()}>Save model</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setAdding(false)}>Cancel</Button></div>
        </div>}
      </div>}
      {!provider.models.length && provider.builtin && <p className="px-4 pb-4 text-sm text-text-muted">No models registered.</p>}
    </div>}
    {msg && <p role="status" className={`px-4 pb-4 text-xs ${msg.danger ? "text-danger" : "text-success"}`}>{msg.text}</p>}
  </section>;
}

function AddProviderForm({ onDone, presets }: { onDone: (v: ProvidersView) => void; presets: ProvidersView['presets'] }) {
  const [open, setOpen] = React.useState(false);
  const [preset, setPreset] = React.useState("");
  const [name, setName] = React.useState("");
  const [apiBase, setApiBase] = React.useState("");
  const [apiStyle, setApiStyle] = React.useState("openai");
  const [backend, setBackend] = React.useState("generic");
  const [envVar, setEnvVar] = React.useState("");
  const [key, setKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const choosePreset = (id: string) => {
    const p = presets.find(p => p.name === id);
    setPreset(id); setName(p?.name || ""); setApiBase(p?.api_base || "");
    setApiStyle(p?.api_style || "openai"); setBackend("generic");
    setEnvVar(p?.api_key_env_var || ""); setKey(""); setMsg(null);
  };
  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      onDone(await upsertProvider({name:name.trim(), api_base:apiBase.trim(), api_style:apiStyle, backend, api_key_env_var:envVar.trim() || undefined, key:key.trim() || undefined}));
      choosePreset(""); setOpen(false);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  };
  if (!open) return <div>
    <h4 className="text-sm font-medium mb-3">Connect a provider</h4>
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
      {presets.map(p => <button key={p.name} type="button" aria-label={p.label} onClick={() => {choosePreset(p.name);setOpen(true);}} className="text-left rounded-lg border border-border px-4 py-3 hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-primary transition-colors">
        <span className="block text-sm font-medium">{LABELS[p.name] || p.label}</span><span className="block text-xs text-text-muted mt-1">{p.name === "codex" ? "CLI sign-in" : p.name === "ollama" ? "Local models" : "API key"}</span>
      </button>)}
      <button type="button" aria-label="Add provider" onClick={() => {choosePreset("");setOpen(true);}} className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-text-muted hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-primary"><Plus size={15} />Custom provider</button>
    </div>
  </div>;
  return <section aria-label="New provider" className="rounded-lg border border-border bg-surface p-5 space-y-4">
    <h4 className="text-sm font-medium">Connect {LABELS[preset] || "a custom provider"}</h4>
    <label className="block text-xs font-medium text-text-muted">Service<Select aria-label="Provider service" className="mt-2 w-full" value={preset} onChange={choosePreset} options={[{value:"",label:"Custom provider"},...presets.map(p => ({value:p.name,label:p.label}))]} /></label>
    {preset === "codex" ? <CodexConnection /> : <>
      {presets.find(p => p.name === preset)?.help && <p className="text-xs text-text-muted leading-relaxed">{presets.find(p => p.name === preset)?.help}</p>}
      {preset === "google" && <a className="inline-block text-sm text-primary underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Get a Google AI Studio API key</a>}
      {preset !== "ollama" && <label className="block text-xs font-medium text-text-muted">API key<Input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="API key (stored in keyring)" className="mt-2" autoComplete="off" /></label>}
    </>}
    <details open={!preset} className="text-xs text-text-muted">
      <summary className="cursor-pointer py-1">Connection settings</summary>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label>Provider name<Input value={name} onChange={e => setName(e.target.value)} placeholder="name (e.g. openai)" className="mt-2" /></label>
        <label>Endpoint URL<Input value={apiBase} onChange={e => setApiBase(e.target.value)} placeholder="https://api.openai.com/v1" className="mt-2" /></label>
        <label>API format<Select value={apiStyle} onChange={setApiStyle} options={API_STYLES} className="mt-2 w-full" /></label>
        <label>Backend<Select value={backend} onChange={setBackend} options={BACKENDS} className="mt-2 w-full" /></label>
        <label>Key environment variable<Input value={envVar} onChange={e => setEnvVar(e.target.value)} placeholder="key env var (e.g. OPENAI_API_KEY)" className="mt-2" /></label>
      </div>
    </details>
    <p className="text-xs text-text-muted">After saving, add available models in the Models menu.</p>
    <div className="flex flex-wrap gap-2"><Button variant="primary" size="sm" disabled={!name.trim() || !apiBase.trim() || busy} onClick={() => void submit()}>Save provider</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => {setKey("");setOpen(false);}}>Cancel</Button></div>
    {msg && <p role="alert" className="text-xs text-danger">{msg}</p>}
  </section>;
}

export function ProvidersSection({mode}: {mode: "providers" | "models"}) {
  const [view, setView] = React.useState<ProvidersView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {getProviders().then(setView).catch(e => setError(String(e)));}, []);
  const onChanged = (v: ProvidersView) => {invalidateVibeModels(); setView(v);};
  return <div className="space-y-6">
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!view && !error && <p className="text-sm text-text-muted">Loading providers…</p>}
    {view && <>
      {mode === "providers" && <AddProviderForm onDone={onChanged} presets={view.presets} />}
      <div className="space-y-3">
        <h4 className="text-sm font-medium">{mode === "providers" ? "Configured providers" : "Registered models"}</h4>
        {view.providers.map(p => <ProviderCard key={p.name} provider={p} mode={mode} onChanged={onChanged} />)}
      </div>
      {mode === "models" && !!view.subagents?.length && <details className="text-sm text-text-muted">
        <summary className="cursor-pointer">Using models as subagents</summary>
        <p className="mt-3 text-xs leading-relaxed">Select any registered model as main, then ask it to use other providers as subagents. Workers receive the supplied task and return findings; the parent handles tools, approvals and edits. Save worker keys in the system keyring or ~/.vibe/.env. Reopen idle conversations after adding providers.</p>
      </details>}
      <p className="text-xs text-text-muted">Providers and models are shared with Vibe CLI. API keys are stored in your system keyring.</p>
    </>}
  </div>;
}
