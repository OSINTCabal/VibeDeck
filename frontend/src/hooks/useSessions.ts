import { useCallback, useEffect, useState } from "react";
import { listSessions, createSession, deleteSession, getHealth, getConfig } from "@/lib/api";
import type { Session, Lane, Health, AppConfig } from "@/lib/types";

export const LANE_AGENT: Record<Lane, string> = {
  work: "ask",
  code: "accept-edits",
};

export const LANES: { key: Lane; label: string; hint: string }[] = [
  { key: "work", label: "Work", hint: "Ask anything — tool actions follow the selected agent's permissions" },
  { key: "code", label: "Code", hint: "Build & edit code — tools, diffs, approvals" },
];

/** Sessions created before the Work/Code redesign carry lane "chat" — fold them into Work. */
export function normalizeLane(lane: string): Lane {
  return lane === "code" ? "code" : "work";
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await listSessions();
      setSessions(d.sessions.map((s) => ({ ...s, lane: normalizeLane(s.lane) })));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    const changed = () => { void refresh(); };
    window.addEventListener("vibedeck:sessions", changed);
    return () => { clearInterval(t); window.removeEventListener("vibedeck:sessions", changed); };
  }, [refresh]);

  const create = useCallback(async (opts: {
    cwd: string; lane: Lane; agent?: string; model?: string; title?: string;
  }) => {
    const s = await createSession({
      cwd: opts.cwd, lane: opts.lane,
      agent: opts.agent || (opts.lane === "work" ? LANE_AGENT.work : undefined),
      model: opts.model,
      title: opts.title,
    });
    await refresh();
    return s;
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    await deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return { sessions, loading, error, refresh, create, remove, setSessions };
}

export function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
    const t = setInterval(() => { if (!document.hidden) getHealth().then(setHealth).catch(() => {}); }, 30000);
    return () => clearInterval(t);
  }, []);
  return health;
}

export function useAppConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    const refresh = () => getConfig().then(setConfig).catch(() => {});
    void refresh();
    window.addEventListener("vibedeck:config", refresh);
    return () => window.removeEventListener("vibedeck:config", refresh);
  }, []);
  return { config, setConfig };
}
