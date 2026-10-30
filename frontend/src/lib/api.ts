import type {
  AppConfig, Health, Session, SseEvent, ModelInfo, SkillInfo,
  McpServerInfo, AgentInfo, JsonPatchOp, ApiKeyStatus,
  ProvidersView, ProviderInfo, ProviderKeyStatus, ProviderModelInfo,
  StudioCosts,
} from "./types";

// In production the sidecar serves the SPA on the same origin (no prefix).
// In dev, Vite proxies /api -> 127.0.0.1:9377.
const BASE = "";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    let code: string | undefined;
    try {
      const d = await res.json();
      // FastAPI validation errors arrive as a detail array — stringify those
      detail = typeof d.detail === "string" ? d.detail : (d.detail || d.error || JSON.stringify(d));
      if (typeof detail !== "string") detail = JSON.stringify(detail);
      if (typeof d.code === "string") code = d.code;
    } catch { /* ignore */ }
    throw Object.assign(new Error(detail), { code });
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------- health/config

export const getHealth = () => http<Health>("/api/health");
export const getConfig = () => http<AppConfig>("/api/config");
export const patchConfig = (body: Partial<AppConfig>) =>
  http<AppConfig>("/api/config", { method: "PATCH", body: JSON.stringify(body) });

// ---------------------------------------------------------------- API key management

export const getApiKeyStatus = () => http<ApiKeyStatus>("/api/settings/api-key");
export const setApiKey = (key: string) =>
  http<ApiKeyStatus>("/api/settings/api-key", { method: "PUT", body: JSON.stringify({ key }) });
export const removeApiKey = () =>
  http<ApiKeyStatus>("/api/settings/api-key", { method: "DELETE" });

// ---------------------------------------------------------------- providers

export const getProviders = () => http<ProvidersView>("/api/providers");
export const upsertProvider = (body: {
  name: string; api_base: string; api_style?: string; backend?: string;
  api_key_env_var?: string; key?: string; models?: Partial<ProviderModelInfo>[];
}) => http<ProvidersView>("/api/providers", { method: "PUT", body: JSON.stringify(body) });
export const removeProvider = (name: string) =>
  http<ProvidersView>("/api/providers/" + encodeURIComponent(name), { method: "DELETE" });
export const getProviderKeyStatus = (name: string) =>
  http<{ provider: string; apiKeyEnvVar: string; key: ProviderKeyStatus }>(
    `/api/providers/${encodeURIComponent(name)}/key`);
export const setProviderKey = (name: string, key: string) =>
  http<{ provider: string; apiKeyEnvVar: string; key: ProviderKeyStatus }>(
    `/api/providers/${encodeURIComponent(name)}/key`,
    { method: "PUT", body: JSON.stringify({ key }) });
export const removeProviderKey = (name: string) =>
  http<{ provider: string; apiKeyEnvVar: string; key: ProviderKeyStatus }>(
    `/api/providers/${encodeURIComponent(name)}/key`, { method: "DELETE" });
export const upsertProviderModel = (name: string, model: Partial<ProviderModelInfo> & { name: string; alias: string }) =>
  http<ProvidersView>(`/api/providers/${encodeURIComponent(name)}/models`,
    { method: "PUT", body: JSON.stringify(model) });
export const removeProviderModel = (name: string, alias: string) =>
  http<ProvidersView>(`/api/providers/${encodeURIComponent(name)}/models/${encodeURIComponent(alias)}`,
    { method: "DELETE" });

// ---------------------------------------------------------------- sessions

export const listSessions = () => http<{ sessions: Session[] }>("/api/sessions");
export const createSession = (body: {
  cwd: string; agent?: string; model?: string; reasoning?: string; lane?: string; title?: string;
}) => http<Session>("/api/sessions", { method: "POST", body: JSON.stringify(body) });
export const getSession = (id: string) => http<Session>(`/api/sessions/${id}`);
export const patchSession = (id: string, body: Record<string, unknown>) =>
  http<Session>(`/api/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteSession = (id: string) =>
  http<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" });
export const stopSession = (id: string) =>
  http<{ ok: boolean }>(`/api/sessions/${id}/stop`, { method: "POST" });
export const resumeSession = (id: string) =>
  http<Session>(`/api/sessions/${id}/resume`, { method: "POST" });
export const releaseSession = (id: string) =>
  http<{ ok: boolean; resumeId: string }>(`/api/sessions/${id}/release`, { method: "POST" });

export const sendTurn = (id: string, text: string, images: unknown[] = [], requestId: string = crypto.randomUUID()) =>
  http<{ turn: unknown; lastEventId: number }>(`/api/sessions/${id}/turns`, {
    method: "POST", body: JSON.stringify({ text, images, requestId }),
  });
export const interruptTurn = (id: string, turnId: string) =>
  http<{ ok: boolean }>(`/api/sessions/${id}/interrupt?turn_id=${encodeURIComponent(turnId)}`, { method: "POST" });
export const resolveCallback = (id: string, callbackId: string, decision: string, feedback?: string, userInput?: unknown) =>
  http<{ ok: boolean }>(`/api/sessions/${id}/callbacks/${callbackId}`, {
    method: "POST", body: JSON.stringify({ decision, feedback, userInput }),
  });

export const getHistory = (id: string, before?: string) =>
  http<{ session: any; history: import("./types").HistoryEntry[]; turns: unknown[];
    activeCallbacks: unknown[]; lastEventId: number; historyBeforeCursor?: string | null }>(
    `/api/sessions/${id}/history${before ? `?before=${encodeURIComponent(before)}` : ""}`);
export const getStats = (id: string) =>
  http<{ session: unknown; total: unknown }>(`/api/sessions/${id}/stats`);
export const getRuntime = (id: string) =>
  http<{ runtime: unknown }>(`/api/sessions/${id}/runtime`);

// ---------------------------------------------------------------- resources

export const getSkills = (sid?: string) =>
  http<{ skills: SkillInfo[]; dir: string; sharedEnabled: boolean; installed?: unknown }>(`/api/skills${sid ? `?sid=${sid}` : ""}`);
export const setSharedSkills = (enabled: boolean) =>
  http<{ enabled: boolean }>("/api/skills/shared", { method: "PUT", body: JSON.stringify({ enabled }) });
export const getMcp = (sid?: string) =>
  http<{ servers: McpServerInfo[]; live?: unknown }>(`/api/mcp${sid ? `?sid=${sid}` : ""}`);
export const getAgents = () => http<{ agents: AgentInfo[]; dir: string }>("/api/agents");
export const getAudit = () => http<{ audit: { action: string; detail: string; ts: number }[] }>("/api/audit");
export const getProjects = () =>
  http<{ home: string; recent: { path: string; name: string; lastUsed: number; branch?: string | null }[];
    known: { path: string; name: string }[]; repos?: { path: string; name: string; branch: string }[] }>("/api/projects");

export interface GitBranches { root: string; current: string | null; branches: string[]; dirty: boolean | null }
export const getGitBranches = (path: string) =>
  http<GitBranches>(`/api/git/branches?path=${encodeURIComponent(path)}`);
export const switchGitBranch = (path: string, branch: string, create = false) =>
  http<GitBranches>("/api/git/switch", { method: "POST", body: JSON.stringify({ path, branch, create }) });

export const getWorkspace = (kind: "connectors" | "libraries", signal?: AbortSignal) =>
  http<{ items: { id: string; name: string; description: string; connected?: boolean; documents?: number | null }[] }>(`/api/workspace/${kind}`, { signal });
export const createWorkspaceLibrary = (name: string, description: string) =>
  http<Awaited<ReturnType<typeof getWorkspace>>["items"][number]>("/api/workspace/libraries", {
    method: "POST", body: JSON.stringify({ name, description }),
  });

// ---------------------------------------------------------------- studio

export const studioModels = () => http<{ models: ModelInfo[] }>("/api/studio/models");
export const studioCompletion = (body: {
  model: string; messages: { role: string; content: string }[];
  temperature?: number; max_tokens?: number; reasoning_effort?: string;
  top_p?: number; random_seed?: number; presence_penalty?: number; frequency_penalty?: number;
  stop?: string[]; json_mode?: boolean; safe_prompt?: boolean;
}) => http<unknown>("/api/studio/completions", { method: "POST", body: JSON.stringify(body) });
export const studioUsage = () => http<unknown>("/api/studio/usage");
export const studioCosts = () => http<StudioCosts>("/api/studio/costs");

export const getUsage = (year: number, month: number, refresh = false) =>
  http<import("./types").UsageSnapshot>(`/api/usage?year=${year}&month=${month}&refresh=${refresh}`);

// ---------------------------------------------------------------- SSE: session events

/** Open the live event stream for a session. Returns a close function. */
export function openSessionEvents(sessionId: string, onEvent: (e: SseEvent) => void): () => void {
  const es = new EventSource(`${BASE}/api/sessions/${sessionId}/events`);
  es.onmessage = (ev) => {
    if (!ev.data || ev.data === "[DONE]") return;
    try {
      onEvent(JSON.parse(ev.data) as SseEvent);
    } catch { /* ignore malformed */ }
  };
  es.onerror = () => {
    onEvent({ kind: "error", error: "Could not connect to this session. If it is open in the Vibe CLI, close it there before continuing here. Retrying…" });
  };
  return () => es.close();
}

// ---------------------------------------------------------------- SSE: direct chat (POST)

export interface ChatStreamHandlers {
  onDelta: (stream: "think" | "text" | "", text: string) => void;
  onDone?: () => void;
  onError?: (err: string) => void;
}

/** Stream a direct API chat completion (POST + SSE). Returns an abort function. */
export function streamChat(
  body: {
    message: string; model?: string; system_prompt?: string;
    reasoning_effort?: string; temperature?: number; max_tokens?: number;
    top_p?: number; random_seed?: number; presence_penalty?: number; frequency_penalty?: number;
    stop?: string[]; json_mode?: boolean; safe_prompt?: boolean;
    attachments?: unknown[]; messages?: { role: string; content: string }[];
  },
  h: ChatStreamHandlers,
): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const t = await res.text();
        h.onError?.(t || res.statusText);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, "\n");
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = raw.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const data = line.slice(6);
          if (data === "[DONE]") { h.onDone?.(); return; }
          let d;
          try { d = JSON.parse(data); } catch { continue; }
          if (d.error) { h.onError?.(d.error); return; }
          if (d.delta) h.onDelta(d.stream || "text", d.delta);
        }
      }
      h.onDone?.();
    } catch (e: any) {
      if (e?.name !== "AbortError") h.onError?.(String(e));
    }
  })();
  return () => ctrl.abort();
}

// ---------------------------------------------------------------- JSON patch

/** Apply a subset of JSON Patch (add/replace/append/remove) to a plain object. */
export function applyPatch<T extends Record<string, any>>(obj: T, patch: JsonPatchOp[]): T {
  let root: any = obj;
  for (const op of patch || []) {
    if (op.path === "") {
      if (op.op === "replace" || op.op === "add") root = op.value;
      continue;
    }
    const parts = op.path.slice(1).split("/").map(k => k.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (parts.some(k => ["__proto__", "constructor", "prototype"].includes(k))) continue;
    let parent: any = root;
    for (const key of parts.slice(0, -1)) {
      if (parent == null || typeof parent !== "object") break;
      parent = parent[key];
    }
    if (parent == null || typeof parent !== "object") continue;
    const key = parts[parts.length - 1];
    if (op.op === "append") {
      if (typeof parent[key] === "string") parent[key] += op.value ?? "";
      else if (Array.isArray(parent[key])) parent[key].push(op.value);
    } else if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > parent.length) continue;
      if (op.op === "add") parent.splice(index, 0, op.value);
      else if (op.op === "remove") parent.splice(index, 1);
      else parent[index] = op.value;
    } else if (op.op === "remove") delete parent[key];
    else parent[key] = op.value;
  }
  return root;
}

export interface SubagentSettings {
  policy: "requested" | "auto" | "off";
  quality: "fast" | "balanced" | "strong";
  max_workers: number;
}
export const getSubagentSettings = () => http<SubagentSettings>("/api/agents/settings");
export const saveSubagentSettings = (settings: SubagentSettings) =>
  http<SubagentSettings>("/api/agents/settings", {method:"PUT", body:JSON.stringify(settings)});
