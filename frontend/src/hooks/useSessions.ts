import { useCallback, useRef, useEffect, useState } from "react";
import { listSessions, deleteSession, getHealth, getConfig } from "@/lib/api";
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

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(async () => {
    try {
      const d = await listSessions();
      const next = d.sessions.map((s) => ({ ...s, lane: normalizeLane(s.lane) }));
      // Polls usually return the same list; keep the old array so the shell
      // and everything under it skip a re-render.
      setSessions(prev => sameJson(prev, next) ? prev : next);
      setError(null);
      // on a cold start the CLI sessions arrive a moment later
      if (d.syncing) window.setTimeout(() => void refreshRef.current(), 1000);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  refreshRef.current = refresh;
  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    const changed = () => { void refresh(); };
    window.addEventListener("vibedeck:sessions", changed);
    return () => { clearInterval(t); window.removeEventListener("vibedeck:sessions", changed); };
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    await deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return { sessions, loading, error, refresh, remove, setSessions };
}

export function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    const keep = (next: Health) => setHealth(prev => sameJson(prev, next) ? prev : next);
    getHealth().then(keep).catch(() => setHealth(null));
    const t = setInterval(() => { if (!document.hidden) getHealth().then(keep).catch(() => {}); }, 30000);
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
