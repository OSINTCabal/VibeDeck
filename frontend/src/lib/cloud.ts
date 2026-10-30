import * as React from "react";
import { parseCloudMessages, parseCloudProjects, parseCloudSessions } from "./api";
import type { CloudError, CloudErrorCode, CloudWebProject, CloudSession, HistoryEntry } from "./types";

/**
 * Vibe Code Web sessions. The desktop shell reads them with the Mistral web
 * sign-in (`window.vibedeck.cloud`); the sidecar parses each response. One
 * store feeds the sidebar and the session view.
 */
export type CloudStatus = "unsupported" | "loading" | "ready" | CloudErrorCode;
export interface CloudState {
  status: CloudStatus;
  message?: string;
  projects: CloudWebProject[];
  sessions: CloudSession[];
  loadedAt: number;
}

const PAGES = 5;
const STALE_MS = 60_000;

export class CloudFailure extends Error {
  constructor(public code: CloudErrorCode, message: string) { super(message); }
}

let state: CloudState = {
  status: typeof window !== "undefined" && window.vibedeck?.cloud ? "loading" : "unsupported",
  projects: [], sessions: [], loadedAt: 0,
};
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function set(next: Partial<CloudState>) {
  state = { ...state, ...next };
  listeners.forEach(listener => listener());
}

/** Read every page of a list, stopping at the first upstream error. */
async function collect<R extends { error?: CloudError; nextCursor: string | null }, T>(
  load: (cursor?: string) => Promise<R>, pick: (result: R) => T[],
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PAGES; page++) {
    const result = await load(cursor);
    if (result.error) throw new CloudFailure(result.error.code, result.error.message);
    items.push(...pick(result));
    if (!result.nextCursor || result.nextCursor === cursor) break;
    cursor = result.nextCursor;
  }
  return items;
}

const failure = (error: unknown): CloudFailure => error instanceof CloudFailure
  ? error : new CloudFailure("unavailable", "Cloud sessions could not be loaded. Check that VibeDeck's sidecar is running.");

export function refreshCloud(): Promise<void> {
  const bridge = window.vibedeck?.cloud;
  if (!bridge) return Promise.resolve();
  inFlight ??= (async () => {
    try {
      const projects = await collect(
        cursor => bridge.read("projects.list", cursor ? { cursor } : {}).then(parseCloudProjects), r => r.projects);
      const lists = await Promise.all(projects.map(project => collect(
        cursor => bridge.read("sessions.list", { projectId: project.id, ...(cursor ? { cursor } : {}) })
          .then(raw => parseCloudSessions(project.id, raw)),
        r => r.sessions)));
      set({ status: "ready", message: undefined, projects, sessions: lists.flat(), loadedAt: Date.now() });
    } catch (error) {
      const { code, message } = failure(error);
      // Offline keeps the last list on screen; a sign-out must not.
      const keep = code === "offline" || code === "blocked" || code === "unavailable";
      set({ status: code, message, loadedAt: Date.now(), ...(keep ? {} : { projects: [], sessions: [] }) });
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

export async function signInToCloud(): Promise<void> {
  const signIn = window.vibedeck?.workspace?.signIn;
  if (!signIn) return;
  if (await signIn("work")) await refreshCloud();
}

export async function loadCloudMessages(sessionId: string): Promise<HistoryEntry[]> {
  const bridge = window.vibedeck?.cloud;
  if (!bridge) throw new CloudFailure("unavailable", "Cloud sessions open in the VibeDeck desktop app.");
  try {
    return await collect(
      cursor => bridge.read("sessions.messages", { sessionId, ...(cursor ? { cursor } : {}) })
        .then(raw => parseCloudMessages(sessionId, raw)),
      r => r.entries);
  } catch (error) {
    throw failure(error);
  }
}

/** The shared cloud list; refreshes on mount, on focus and every few minutes while visible. */
export function useCloud(): CloudState {
  const snapshot = React.useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => state);
  React.useEffect(() => {
    if (!window.vibedeck?.cloud) return;
    const stale = () => { if (!document.hidden && Date.now() - state.loadedAt > STALE_MS) void refreshCloud(); };
    stale();
    const timer = window.setInterval(stale, STALE_MS * 3);
    window.addEventListener("focus", stale);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", stale); };
  }, []);
  return snapshot;
}
