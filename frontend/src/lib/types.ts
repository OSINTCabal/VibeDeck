export type Lane = "work" | "code";

export interface Session {
  id: string;
  title: string;
  cwd: string;
  agent: string;
  model: string;
  reasoning: string | null;
  status: string;
  lane: Lane;
  last_event_id: number;
  created_at: number;
  updated_at: number;
  /** where the session came from: created in VibeDeck or imported from the vibe CLI store */
  origin?: "vibedeck" | "vibe";
  /** non-fatal setup issues from creation (e.g. model/agent not applied) */
  warnings?: string[];
  costs?: SessionCosts;
  live?: boolean;
}

export interface SessionCosts {
  session_id: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  input_price_per_million: number;
  output_price_per_million: number;
  updated_at: number;
}

/** /api/studio/costs — per-session token counts + estimated spend. */
export interface StudioCosts {
  total: {
    p: number; c: number; ca: number; ic: number; oc: number;
    estimated_cost_usd: number;
  };
  sessions: { id: string; costs?: SessionCosts }[];
}

export interface AppConfig {
  defaultModel: string;
  defaultAgent: string;
  defaultReasoning: string | null;
  agentModes: string[];
  reasoningLevels: string[];
  approvalDecisions: string[];
  /** Model aliases the vibe CLI's app-server accepts for sessions. */
  vibeModels?: VibeModelInfo[];
}

export interface VibeModelInfo {
  id: string;
  name: string;
  supportsImages: boolean;
  thinkingLevels: string[];
  maxContextLength?: number | null;
  autoCompactThreshold?: number | null;
  thinking?: string | null;
}

export interface Health {
  ok: boolean;
  app_server: boolean;
  vibe_cli: boolean;
  api_key: boolean;
  api_key_source?: "env" | "keyring" | "file" | "disabled" | null;
  default_model: string;
  default_agent: string;
  version: string;
  user?: string;
}

/** Where the effective Mistral API key comes from — never includes the key itself. */
export interface ApiKeyStatus {
  present: boolean;
  source: "env" | "keyring" | "file" | "disabled" | null;
  disabled: boolean;
  file: string;
  /** masked key preview (first 4 + last 4) — never the key itself */
  fingerprint?: string | null;
}

// ---- history entries (from the vibe app-server) ----

export interface ContentBlock {
  type: "text" | "image" | "resource";
  text?: string;
  [k: string]: unknown;
}

export interface HistoryEntry {
  id: string;
  sessionId: string;
  turnId: string;
  type: "message" | "reasoning" | "effect" | "callback" | "notice" | "checkpoint" | string;
  role?: "system" | "user" | "assistant";
  content?: ContentBlock[];
  text?: string;
  title?: string;
  detail?: Record<string, any>;
  state?: Record<string, any>;
  callbackId?: string;
  generationStatus?: string;
  createdAt: number;
  updatedAt: number;
  relatedEntryId?: string | null;
}

export interface Turn {
  id: string;
  sessionId: string;
  status: string;
  startedAt: number;
  completedAt?: number | null;
  stopReason?: string | null;
}

export interface SessionStats {
  steps: number;
  sessionPromptTokens: number;
  sessionCompletionTokens: number;
  sessionCachedTokens: number;
  contextTokens: number;
  toolCallsAgreed: number;
  toolCallsRejected: number;
  toolCallsFailed: number;
  toolCallsSucceeded: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  lastTurnDuration?: number;
  tokensPerSecond?: number;
}

// ---- SSE event envelopes ----

export type SseEvent =
  | { kind: "snapshot"; session: any; activeCallbacks: HistoryEntry[]; lastEventId: number;
      history?: HistoryEntry[]; turns?: Turn[]; childSessions?: ChildSession[];
      historyBeforeCursor?: string | null; stats?: SessionStats }
  | { kind: "entry"; action: "add"; entry: HistoryEntry }
  | { kind: "entry"; action: "update"; entryId: string; patch: JsonPatchOp[]; entry?: HistoryEntry }
  | { kind: "turn"; status: "started" | "completed"; turn: Turn }
  | { kind: "stats"; stats: SessionStats }
  | { kind: "runtime"; runtime: any }
  | { kind: "session"; sessionId: string; patch: JsonPatchOp[] }
  | { kind: "callback"; callback: HistoryEntry }
  | { kind: "childSession"; childSession: any }
  | { kind: "error"; error: string }
  | { kind: "raw"; method: string; params: any };

export interface JsonPatchOp {
  op: "add" | "replace" | "append" | "remove";
  path: string;
  value?: any;
}

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  maxContextLength: number | null;
  functionCalling: boolean;
  vision: boolean;
  ownedBy: string;
  /** Reasoning levels the vibe CLI accepts for this model, and its default. */
  thinkingLevels?: string[];
  defaultThinking?: string | null;
}

export interface SkillInfo {
  name: string;
  path: string;
  size: number;
}

export interface McpServerInfo {
  name: string;
  transport?: string;
  command?: string;
  url?: string;
  raw?: string;
}

export interface AgentInfo {
  name: string;
  path?: string;
  displayName?: string;
  description?: string;
  safety?: string;
  /** "agent" = approval mode, "subagent" = spawnable/switchable worker profile. */
  agentType?: "agent" | "subagent" | string;
}

// ---- providers (multi-provider: any AI provider, models usable everywhere) ----

export interface ProviderModelInfo {
  name: string;
  provider: string;
  alias: string;
  display_name?: string;
  temperature?: number;
  input_price?: number;
  output_price?: number;
  thinking?: string;
  supports_images?: boolean;
  max_context_length?: number;
  auto_compact_threshold?: number;
}

export interface ProviderKeyStatus {
  present: boolean;
  source: "env" | "keyring" | "file" | null;
}

export interface ProviderInfo {
  name: string;
  apiBase: string;
  apiStyle: string;
  backend: string;
  apiKeyEnvVar: string;
  key: ProviderKeyStatus;
  models: ProviderModelInfo[];
  builtin?: boolean;
}

export interface ProvidersView {
  configPath: string;
  providers: ProviderInfo[];
  presets: { name: string; label: string; api_base: string; api_style: string; api_key_env_var: string; help: string }[];
  subagents: { name: string; model: string }[];
}

/** A live subagent (child session) spawned by the model mid-turn. */
export interface ChildSession {
  id: string;
  name: string;
  agentType: string;
  /** Wire shape is a discriminated union: {type: "running" | "idle" | ...}. */
  status: string | { type?: string };
  tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  contextUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
  createdAt: number;
  updatedAt: number;
}

export interface UsageAllowance {
  id: string; label: string; usedPercent: number; used: number | null;
  limit: number | null; remaining: number | null; currency: string | null;
  resetAt: string | null; source: string; measuredAt: string;
}
export interface BillingRow {
  day: string; model: string; inputTokens: number; outputTokens: number; cachedTokens: number; cost: number;
}
export interface BillingUsage {
  status: string; source: string; measuredAt: string; currency: string | null; cost: number | null;
  inputTokens: number; outputTokens: number; cachedTokens: number; rows: BillingRow[];
  startDate: string | null; endDate: string | null; detail?: string | null;
}
export interface UsageSnapshot {
  status: string; source: string; measuredAt?: string;
  account?: { label: string; source: string; status?: string; plan?: string | null; kind?: string | null };
  allowances: UsageAllowance[]; billing: BillingUsage | null; detail?: string | null;
  limits?: { currency?: string | null; monthlyLimitReached?: boolean | null };
  local?: { rows: { day: string; model: string | null; source: string; prompt_tokens: number;
    completion_tokens: number; cached_tokens: number; estimated_cost_usd: number }[];
    observedSince: number | null; historicalTotals: StudioCosts["total"] };
}
