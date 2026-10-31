import * as React from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import {
  getApiKeyStatus, patchConfig, removeApiKey, setApiKey,
  listSessions, deleteSession, getSubagentSettings, saveSubagentSettings, type SubagentSettings,
} from "@/lib/api";
import { Card, CardBody, Select, Badge, Button, Input } from "@/components/ui";
import { useVibeModels } from "@/components/Pickers";
import { ProvidersSection } from "@/components/ProvidersSection";
import { VibeReleaseNotes } from "@/components/VibeReleaseNotes";
import { THEMES, getTheme, setTheme, type ThemeId } from "@/lib/theme";
import {
  notificationsEnabled, setNotificationsEnabled, notificationsSupported,
} from "@/lib/notifications";
import { Check, Plug, Boxes, SlidersHorizontal } from "lucide-react";
import { cn, modelLabel } from "@/lib/utils";
import type { ApiKeyStatus } from "@/lib/types";
import type { DesktopSettings } from "@/lib/windowControls";

const AGENTS = [
  { value: "ask", label: "ask — asks permission for actions that need approval" },
  { value: "plan", label: "plan — reads files and plans without editing" },
  { value: "accept-edits", label: "accept-edits — edits files freely, asks for risky commands" },
  { value: "auto-approve", label: "Full auto — approves all tool actions automatically" },
];
const REASONING = [
  { value: "", label: "Default" }, { value: "off", label: "Off" }, { value: "low", label: "Low" },
  { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "max", label: "Max" },
];

function keyStatusLabel(s: ApiKeyStatus | null): { text: string; tone: "success" | "warning" | "danger" } {
  if (!s) return { text: "…", tone: "warning" };
  if (s.present) return { text: "Key available", tone: "success" };
  return { text: "Not configured", tone: s.source === "disabled" ? "warning" : "danger" };
}

function keySourceLabel(source: ApiKeyStatus["source"]): string {
  switch (source) {
    case "env": return "environment";
    case "keyring": return "system keyring";
    case "file": return "saved file";
    default: return "";
  }
}

export function SettingsView() {
  const { health, config } = useOutletContext<any>();
  const [notesOpen, setNotesOpen] = React.useState(false);
  const [params] = useSearchParams();
  const section = params.get("section") === "models" ? "models" : params.get("section") === "config" ? "config" : "providers";
  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [section]);
  const [model, setModel] = React.useState(config?.defaultModel || "mistral-large-4");
  const [agent, setAgent] = React.useState(config?.defaultAgent || "accept-edits");
  const [reasoning, setReasoning] = React.useState(config?.defaultReasoning || "");
  const { models } = useVibeModels();
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<string | null>(null);

  const [keyStatus, setKeyStatus] = React.useState<ApiKeyStatus | null>(null);
  const [keyInput, setKeyInput] = React.useState("");
  const [keyBusy, setKeyBusy] = React.useState(false);
  const [keyMsg, setKeyMsg] = React.useState<{ text: string; danger?: boolean } | null>(null);
  const [swapping, setSwapping] = React.useState(false);

  React.useEffect(() => { getApiKeyStatus().then(setKeyStatus).catch(() => setKeyMsg({text: "Could not check the Studio API key. Reopen Settings to retry.", danger: true})); }, []);
  React.useEffect(() => {
    if (config) { setModel(config.defaultModel); setAgent(config.defaultAgent); setReasoning(config.defaultReasoning || ""); }
  }, [config]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await patchConfig(section === "models" ? { defaultModel: model } : { defaultAgent: agent, defaultReasoning: reasoning || null });
      window.dispatchEvent(new Event("vibedeck:config"));
      setSaveError(null);
      setSaved(section);
      setTimeout(() => setSaved(null), 2000);
    } catch (e) { setSaveError(String(e)); }
    finally { setSaving(false); }
  };

  const saveKey = async () => {
    const key = keyInput.trim();
    if (!key || keyBusy) return;
    const wasPresent = keyStatus?.present;
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      setKeyStatus(await setApiKey(key));
      setKeyInput("");
      setSwapping(false);
      setKeyMsg({ text: wasPresent ? "Key updated." : "API key saved." });
    } catch (e) {
      setKeyMsg({ text: `Failed to save key: ${e}`, danger: true });
    } finally {
      setKeyBusy(false);
    }
  };

  const removeKey = async () => {
    if (keyBusy) return;
    setKeyBusy(true);
    setKeyMsg(null);
    try {
      setKeyStatus(await removeApiKey());
      setKeyMsg({ text: "Studio API key removed. Your browser and CLI accounts are unchanged." });
    } catch (e) {
      setKeyMsg({ text: `Failed to remove key: ${e}`, danger: true });
    } finally {
      setKeyBusy(false);
    }
  };

  const modelOptions = models.length
    ? models.map((m) => ({ value: m.id, label: modelLabel(m.id, m.name) }))
    : [{ value: model, label: modelLabel(model) }];

  const ksl = keyStatusLabel(keyStatus);

  return (
    <div className="h-full flex flex-col settings-page">
      <header className="shrink-0 border-b border-border px-6 py-5">
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-text-muted mt-1">Make VibeDeck work the way you do.</p>
      </header>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-5 py-6 lg:px-8 lg:py-8 grid grid-cols-1 xl:grid-cols-[176px_minmax(0,1fr)] gap-6 xl:gap-10">
        <nav aria-label="Settings sections" className="flex gap-1 xl:flex-col xl:self-start xl:sticky xl:top-8">
          {[
            { id: "providers", label: "Providers", icon: Plug },
            { id: "models", label: "Models", icon: Boxes },
            { id: "config", label: "Config", icon: SlidersHorizontal },
          ].map(item => <Link key={item.id} to={`/settings?section=${item.id}`} aria-current={section === item.id ? "page" : undefined}
            className={cn("flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-primary", section === item.id ? "bg-surface-muted text-text font-medium" : "text-text-muted hover:text-text hover:bg-surface-muted/60")}>
            <item.icon size={16} />{item.label}
          </Link>)}
        </nav>
        <section className="min-w-0 space-y-6" aria-label={`${section} settings`}>
          <div>
            <h3 className="text-base font-semibold">{section === "providers" ? "Providers" : section === "models" ? "Models" : "Config"}</h3>
            <p className="mt-1 text-sm text-text-muted">{section === "providers" ? "Connect your AI services and manage credentials." : section === "models" ? "Choose your default model and manage models from connected providers." : "Appearance, conversation defaults and desktop preferences."}</p>
          </div>
          {saveError && <p role="alert" className="text-sm text-danger">{saveError}</p>}
          {section === "models" && <Card><CardBody className="space-y-3">
            <label className="block text-sm font-medium">Default model
              <Select aria-label="Default model" value={model} onChange={setModel} options={modelOptions} className="mt-2 w-full" />
            </label>
            <p className="text-xs text-text-muted">Used for new conversations. Any registered model can also be selected in a session.</p>
            <Button variant="primary" size="sm" disabled={saving} onClick={save}>{saving ? "Saving..." : saved === section ? "Saved" : "Save defaults"}</Button>
          </CardBody></Card>}
          {section !== "config" && <ProvidersSection mode={section} />}
      {section === "providers" && <>
      <Card>
        <details>
          <summary className="flex items-center justify-between gap-3 p-4 cursor-pointer list-none focus-visible:ring-2 focus-visible:ring-primary" aria-label="Manage Mistral Studio API key">
            <span className="text-sm font-medium">Mistral Studio API key</span>
            <Badge tone={ksl.tone}>{ksl.text}</Badge>
          </summary>
          <CardBody className="space-y-4 border-t border-border">
          {keyStatus?.present && !swapping ? (
            <>
              <div className="flex items-center justify-between gap-3 rounded-md bg-surface-muted px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[11px] text-text-faint">API key</div>
                  <div className="font-mono text-sm text-text truncate">
                    {keyStatus.fingerprint || "••••"}
                  </div>
                </div>
                <div className="shrink-0 text-[11px] text-text-faint">
                  {keySourceLabel(keyStatus.source)}
                </div>
              </div>
              <p className="text-xs text-text-faint">
                Used by the Studio playground and direct API chat. The vibe CLI keeps its own
                login in the system keyring — signing out here does not affect it.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => { setSwapping(true); setKeyMsg(null); }}>
                  Swap key
                </Button>
                <Button variant="outline" size="sm" onClick={removeKey} disabled={keyBusy}>
                  Remove API key
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-text-faint">
                {keyStatus?.present
                  ? "Paste a different key to replace the current one."
                  : <>Add your Mistral API key — it is stored in <code className="font-mono">{keyStatus?.file || "~/.config/vibedeck/env"}</code> (0600).</>}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveKey(); }}
                  placeholder={keyStatus?.present ? "Paste a new key…" : "Paste your Mistral API key…"}
                  className="font-mono h-8"
                  autoComplete="off"
                  autoFocus={swapping}
                />
                <Button variant="primary" size="sm" onClick={saveKey} disabled={!keyInput.trim() || keyBusy}>
                  {keyStatus?.present ? "Save new key" : "Save API key"}
                </Button>
                {keyStatus?.present && (
                  <Button variant="outline" size="sm" onClick={() => { setSwapping(false); setKeyInput(""); setKeyMsg(null); }}>
                    Cancel
                  </Button>
                )}
              </div>
            </>
          )}
          {keyMsg && (
            <div className={`text-xs ${keyMsg.danger ? "text-danger" : "text-success"}`}>{keyMsg.text}</div>
          )}
        </CardBody>
        </details>
      </Card>


      </>}
      {section === "config" && <>
      <Subagents />
      <Card><CardBody className="space-y-3">
        <h4 className="text-sm font-medium">Skills and connections</h4>
        <p className="text-xs text-text-muted">Local skills and MCP configuration are shared with the Vibe CLI. Web services use your Mistral workspace account.</p>
        <div className="flex flex-wrap gap-3 text-sm text-primary">
          <Link to="/skills" className="hover:underline">CLI skills and shared skills</Link>
          <Link to="/mcp" className="hover:underline">Local MCP servers</Link>
          <Link to="/workspace/connectors" className="hover:underline">Web connectors</Link>
        </div>
      </CardBody></Card>
      <Card>
        <CardBody className="space-y-4">
          <div className="text-xs font-medium text-text-muted">Appearance</div>
          <ThemePicker />
          <ZoomControl />
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-text-muted">Desktop notifications</div>
              <p className="text-xs text-text-faint mt-0.5">
                Turn-complete and approval alerts while the window is unfocused.
              </p>
            </div>
            <NotificationsToggle />
          </div>
          <TrayControl />
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1.5">Default lane</label>
            <DefaultLaneSelect />
            <p className="text-xs text-text-faint mt-1">Lane new chats open in (Work or Code).</p>
          </div>
        </CardBody>
      </Card>


      <Card>
        <CardBody className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1.5">Default agent mode</label>
            <Select aria-label="Default agent mode" value={agent} onChange={setAgent} options={AGENTS} className="w-full" />
            <p className="mt-1 text-xs text-text-muted">Used for new Code sessions. Work starts in ask mode; you can change the mode in any conversation.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1.5">Default reasoning</label>
            <Select aria-label="Default reasoning" value={reasoning} onChange={setReasoning} options={REASONING} className="w-full" />
          </div>
          <Button variant="primary" size="sm" disabled={saving} onClick={save}>{saving ? "Saving..." : saved === section ? "Saved" : "Save defaults"}</Button>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="text-xs font-medium text-text-muted mb-2">Runtime</div>
          <div className="space-y-1.5 text-sm">
            <Row label="Sidecar" value={health?.ok ? "connected" : "offline"} tone={health?.ok ? "success" : "danger"} />
            <Row label="vibe CLI" value={health?.vibe_cli ? "installed" : "missing"} tone={health?.vibe_cli ? "success" : "danger"} />
            <Row label="app-server" value={health?.app_server ? "available" : "missing"} tone={health?.app_server ? "success" : "danger"} />
            <Row
              label="API key"
              value={health?.api_key ? `present${health?.api_key_source ? ` · ${health.api_key_source}` : ""}` : "missing"}
              tone={health?.api_key ? "success" : "warning"}
            />
            <Row label="Version" value={`vibedeck ${health?.version || "—"}`} />
            <div className="flex items-center justify-between">
              <span className="text-text-muted">Vibe</span>
              <span className="flex items-center gap-2">
                {health?.vibe?.outdated && <Badge tone="warning">{health.vibe.recommended} available</Badge>}
                <span className="font-mono text-xs">{health?.vibe?.version || "—"}</span>
                <button type="button" onClick={() => setNotesOpen(true)} className="text-xs text-primary hover:underline">What’s new</button>
              </span>
            </div>
            {health?.vibe?.outdated && (
              <p className="text-xs text-text-faint">
                Update with <code className="font-mono">{health.vibe.upgradeCommand}</code> for custom thinking levels and teleport fixes.
              </p>
            )}
          </div>
          <VibeReleaseNotes open={notesOpen} onClose={() => setNotesOpen(false)} />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="text-xs font-medium text-text-muted">Danger zone</div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs text-text">Delete all sessions</div>
              <p className="text-xs text-text-faint mt-0.5">
                Removes every session and its local history. Cannot be undone.
              </p>
            </div>
            <DeleteAllSessions />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="text-xs font-medium text-text-muted mb-2">Privacy</div>
          <ul className="text-xs text-text-muted space-y-1 list-disc pl-4">
            <li>The sidecar listens on 127.0.0.1. Local processes can access its API.</li>
            <li>Model calls use your configured providers. Usage sign-in contacts Mistral and your identity provider.</li>
            <li>API keys live in the keyring or local env file. Usage cookies stay in a separate desktop profile.</li>
            <li>The local audit log records selected control actions. Conversations stay in the shared Vibe store.</li>
          </ul>
        </CardBody>
      </Card>
      </>}
        </section>
      </div>
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "success" | "danger" | "warning" }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-muted">{label}</span>
      {tone ? <Badge tone={tone}>{value}</Badge> : <span className="font-mono text-xs">{value}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- theme picker

function ThemePicker() {
  const [theme, setThemeState] = React.useState<ThemeId>(getTheme());
  const pick = (id: ThemeId) => {
    setTheme(id);
    setThemeState(id);
  };
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {THEMES.map((t) => {
        const active = t.id === theme;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => pick(t.id)}
            title={t.description}
            aria-pressed={active}
            className={cn(
              "relative rounded-lg border p-2.5 text-left transition-colors",
              active ? "border-primary ring-1 ring-primary" : "border-border hover:border-border-strong",
            )}
          >
            <span
              className="block h-9 rounded-md border border-black/10 dark:border-white/10 mb-2"
              style={{
                background: `linear-gradient(135deg, ${t.swatch.bg} 55%, ${t.swatch.surface} 55%)`,
              }}
            >
              <span
                className="inline-block h-2 w-2 rounded-full ml-1.5 mt-1.5"
                style={{ background: t.swatch.primary }}
              />
            </span>
            <span className="flex items-center gap-1 text-xs text-text">
              {t.name}
              {active && <Check size={11} className="text-primary shrink-0" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- notifications toggle

function NotificationsToggle() {
  const [enabled, setEnabled] = React.useState(notificationsEnabled());
  const supported = notificationsSupported();
  return (
    <button
      type="button"
      role="switch"
      aria-label="Desktop notifications"
      aria-checked={enabled}
      disabled={!supported}
      onClick={() => { setNotificationsEnabled(!enabled); setEnabled(!enabled); }}
      title={supported ? undefined : "Notifications are not supported in this browser"}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        enabled ? "bg-primary" : "bg-surface-muted",
        !supported && "opacity-50",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
          enabled ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------- default lane

function DefaultLaneSelect() {
  const [lane, setLane] = React.useState<string>(
    () => localStorage.getItem("vibedeck.lane") || "code");
  const change = (v: string) => {
    setLane(v);
    try { localStorage.setItem("vibedeck.lane", v); } catch { /* ignore */ }
    // AppShell listens and switches the live lane
    window.dispatchEvent(new CustomEvent("vibedeck:lane", { detail: v }));
  };
  return (
    <Select
      aria-label="Default lane"
      value={lane}
      onChange={change}
      options={[
        { value: "code", label: "Code — build & edit, tools and approvals" },
        { value: "work", label: "Work — ask anything, fast answers" },
      ]}
      className="w-full"
    />
  );
}

// ---------------------------------------------------------------- delete all sessions

function DeleteAllSessions() {
  const [busy, setBusy] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState("");
  const run = async () => {
    setBusy(true); setError("");
    try {
      const { sessions } = await listSessions();
      const results = await Promise.allSettled(sessions.map((s) => deleteSession(s.id)));
      const failed = results.filter(result => result.status === "rejected").length;
      window.dispatchEvent(new Event("vibedeck:sessions"));
      if (failed) { setError(`${failed} session(s) could not be deleted. Retry to remove the remaining sessions.`); return; }
      setDone(true);
      setTimeout(() => { setDone(false); setConfirming(false); }, 2500);
    } catch { setError("Could not load sessions. Nothing was deleted. Try again."); } finally {
      setBusy(false);
    }
  };
  if (done) return <Badge tone="success">deleted</Badge>;
  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {error && <p role="alert" className="w-full text-xs text-danger">{error}</p>}
        <Button variant="danger" size="sm" disabled={busy} onClick={run}>
          {busy ? "Deleting…" : "Confirm delete"}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
      Delete all
    </Button>
  );
}

function ZoomControl() {
  const desktop = window.vibedeck;
  const [factor, setFactor] = React.useState(1);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => { void desktop?.getZoom().then(setFactor).catch(() => setError("Could not read zoom settings.")); }, [desktop]);
  const change = async (value: string) => {
    if (!desktop || busy) return;
    setBusy(true); setError("");
    try { setFactor(await desktop.setZoom(Number(value))); }
    catch { setError("Could not save zoom. Try again."); }
    finally { setBusy(false); }
  };
  return <div className="space-y-2">
    <label className="block text-sm font-medium">App zoom
      <Select aria-label="App zoom" className="mt-2 w-full" disabled={!desktop || busy} value={String(factor)} onChange={value => void change(value)} options={[.75,.9,1,1.1,1.25,1.5].map(value => ({value:String(value),label:`${Math.round(value*100)}%${value===1 ? " (default)" : ""}`}))} />
    </label>
    <p className="text-xs text-text-muted">Scales the desktop and embedded pages. Saved for your next launch.</p>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </div>;
}


function TrayControl() {
  const desktop = window.vibedeck?.desktop;
  const [settings, setSettings] = React.useState<DesktopSettings | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => { void desktop?.get().then(setSettings).catch(() => setError("Could not read desktop settings.")); }, [desktop]);
  if (!desktop) return null;
  const toggle = async (closeToTray: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    try { setSettings(await desktop.set({ closeToTray })); }
    catch { setError("Could not save this setting. Try again."); }
    finally { setBusy(false); }
  };
  const enabled = !!settings?.closeToTray;
  const available = !!settings?.tray;
  return <div>
    <div className="flex items-center justify-between">
      <div>
        <div className="text-xs font-medium text-text-muted">Keep running in the tray</div>
        <p className="text-xs text-text-faint mt-0.5">{settings && !available
          ? "Your desktop has no system tray, so closing the window quits VibeDeck."
          : "Closing the window hides VibeDeck to the tray icon. Quit from the tray menu."}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-label="Keep running in the tray"
        aria-checked={enabled}
        disabled={busy || !available}
        onClick={() => void toggle(!enabled)}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          enabled ? "bg-primary" : "bg-surface-muted",
          (busy || !available) && "opacity-50",
        )}
      >
        <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", enabled ? "left-[18px]" : "left-0.5")} />
      </button>
    </div>
    {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
  </div>;
}

function Subagents() {
  const [settings, setSettings] = React.useState<SubagentSettings | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    let closed = false;
    setError("");
    getSubagentSettings().then(value => { if (!closed) setSettings(value); })
      .catch(error => {
        if (closed) return;
        if (error.code === "invalid_agent_settings") {
          setSettings({policy:"off",quality:"balanced",max_workers:2});
          setSaved(false);
          setError("Subagent settings could not be read. Review these safe defaults and save to repair them.");
        } else setError("Could not load subagent settings.");
      });
    return () => { closed = true; };
  }, [revision]);
  return <Card><CardBody className="space-y-3">
    <h4 className="text-sm font-medium">Subagents</h4>
    <p className="text-xs text-text-muted">Built into VibeDeck and shared with the CLI. Mistral stays the default main provider. Workers can use any configured model; no external Fleet installation is needed.</p>
    {error && <div className="flex items-center gap-2"><p role="alert" className="text-xs text-danger">{error}</p>{!settings && <Button variant="ghost" size="sm" onClick={() => setRevision(n => n + 1)}>Retry</Button>}</div>}
    {settings && <>
      <label className="block text-xs text-text-muted">Delegation
        <Select aria-label="Subagent delegation" disabled={busy} value={settings.policy} options={[{value:"requested",label:"When I ask"},{value:"auto",label:"Automatic for substantial work"},{value:"off",label:"Off"}]} onChange={value => {setSettings({...settings,policy:value as SubagentSettings["policy"]});setSaved(false);}} className="mt-1 w-full" />
      </label>
      <label className="block text-xs text-text-muted">Default worker quality
        <Select aria-label="Subagent quality" disabled={busy} value={settings.quality} options={[{value:"fast",label:"Fast"},{value:"balanced",label:"Balanced"},{value:"strong",label:"Strong"}]} onChange={value => {setSettings({...settings,quality:value as SubagentSettings["quality"]});setSaved(false);}} className="mt-1 w-full" />
      </label>
      <label className="block text-xs text-text-muted">Workers per batch
        <Select aria-label="Subagent worker limit" disabled={busy} value={String(settings.max_workers)} options={[1,2,3].map(n=>({value:String(n),label:String(n)}))} onChange={value => {setSettings({...settings,max_workers:Number(value)});setSaved(false);}} className="mt-1 w-full" />
      </label>
      <p className="text-xs text-text-faint">At most two workers run concurrently, with one editing worker per batch. Repository agents can read files or edit when requested; the main agent runs commands and reviews changes. Trivial tasks should stay with the main model.</p>
      <p className="text-xs text-text-faint">Try “Use DeepSeek and Z.ai subagents with strong models and high thinking.” Exact provider/model requests override automatic selection. Automatic selection uses model-name hints, not benchmark scores. Only registered models are eligible.</p>
      <Button size="sm" variant="primary" disabled={busy} onClick={async () => {
        setBusy(true);setError("");setSaved(false);
        try {setSettings(await saveSubagentSettings(settings));setSaved(true);}
        catch {setError("Could not save subagent settings. Your choices are still here; retry saving.");}
        finally {setBusy(false);}
      }}>{busy ? "Saving..." : saved ? "Saved" : "Save subagents"}</Button>
    </>}
  </CardBody></Card>;
}
