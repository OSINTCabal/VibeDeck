import { useCallback, useEffect, useRef, useState } from "react";
import { getHistory, openSessionEvents, applyPatch } from "@/lib/api";
import type { ChildSession, HistoryEntry, SessionStats, SseEvent } from "@/lib/types";

export interface ConversationState {
  entries: HistoryEntry[];
  session: any | null;
  turnStatus: "idle" | "running" | "completed";
  activeTurnId: string | null;
  stats: SessionStats | null;
  pendingCallbacks: HistoryEntry[];
  childSessions: Record<string, ChildSession>;
  loading: boolean;
  error: string | null;
  lastEventId: number;
  historyBeforeCursor: string | null;
}

export const initialConversation = (): ConversationState => ({
  entries: [], session: null, turnStatus: "idle", activeTurnId: null,
  stats: null, pendingCallbacks: [], childSessions: {},
  loading: true, error: null, lastEventId: 0, historyBeforeCursor: null,
});

export function conversationEvent(s: ConversationState, ev: SseEvent): ConversationState {
  const event = ev as any;
  if (ev.kind !== "snapshot" && event.lastEventId != null && event.lastEventId <= s.lastEventId) return s;
  let next = { ...s, lastEventId: event.lastEventId ?? s.lastEventId };
  switch (ev.kind) {
    case "snapshot": {
      const status = ev.session?.status;
      const running = status?.type === "running" || status?.type === "blocked";
      const history = ev.history || [];
      const ids = new Set(history.map(e => e.id));
      const entries = [...history, ...(ev.activeCallbacks || []).filter(e => !ids.has(e.id))];
      // Retain older pages already loaded; replace every entry covered by this snapshot.
      const known = new Set(entries.map((e: HistoryEntry) => e.id));
      const first = entries[0]?.id;
      const boundary = first ? s.entries.findIndex(e => e.id === first) : -1;
      const older = boundary > 0 ? s.entries.slice(0, boundary).filter(e => !known.has(e.id)) : [];
      next = {
        ...initialConversation(), lastEventId: ev.lastEventId,
        entries: [...older, ...entries], session: ev.session, loading: false,
        turnStatus: running ? "running" : "idle",
        activeTurnId: running ? status.activeTurnId : null,
        pendingCallbacks: ev.activeCallbacks || [],
        childSessions: Object.fromEntries((ev.childSessions || []).map(c => [c.id, c])),
        stats: ev.stats ?? s.stats,
        historyBeforeCursor: ev.historyBeforeCursor ?? null,
      };
      break;
    }
    case "entry":
      if (ev.action === "add") {
        next.entries = s.entries.some(e => e.id === ev.entry.id)
          ? s.entries.map(e => e.id === ev.entry.id ? ev.entry : e)
          : [...s.entries, ev.entry];
      } else {
        next.entries = s.entries.map(e => e.id === ev.entryId
          ? (ev.entry || applyPatch(structuredClone(e), ev.patch)) : e);
      }
      next.pendingCallbacks = next.entries.filter(e => e.type === "callback" && e.state?.status === "open");
      break;
    case "turn":
      next.turnStatus = ev.status === "started" ? "running" : "completed";
      next.activeTurnId = ev.status === "started" ? ev.turn.id : null;
      break;
    case "stats": next.stats = ev.stats; break;
    case "session":
      next.session = applyPatch(structuredClone(s.session || {}), ev.patch);
      break;
    case "callback":
      next.entries = s.entries.some(e => e.id === ev.callback.id)
        ? s.entries.map(e => e.id === ev.callback.id ? ev.callback : e)
        : [...s.entries, ev.callback];
      next.pendingCallbacks = next.entries.filter(e => e.type === "callback" && e.state?.status === "open");
      break;
    case "childSession": next.childSessions = { ...s.childSessions, [ev.childSession.id]: ev.childSession }; break;
    case "error": next.error = ev.error; next.loading = false; break;
  }
  return next;
}

export function useConversation(sessionId: string | undefined, released = false) {
  const [state, setState] = useState<ConversationState>(initialConversation);
  const identity = useRef(sessionId);
  const stateRef = useRef(state);
  stateRef.current = state;
  const disconnect = useRef<(() => void) | null>(null);
  const pageBusy = useRef(false);
  const reconnect = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (released) return;
    identity.current = sessionId;
    stateRef.current = initialConversation();
    setState(initialConversation());
    pageBusy.current = false;
    if (!sessionId || released) return;
    const connect = () => {
      let closed = false;
      let frame = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pending: SseEvent[] = [];
      const flush = () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        frame = 0;
        timer = undefined;
        const events = pending;
        pending = [];
        if (!closed && events.length) setState(s => events.reduce(conversationEvent, s));
      };
      document.addEventListener("visibilitychange", flush);
      const close = openSessionEvents(sessionId, ev => {
        if (closed) return;
        if (ev.kind === "turn" && ev.status !== "started") window.dispatchEvent(new Event("vibedeck:usage-refresh"));
        pending.push(ev);
        if (document.hidden || pending.length >= 128 || ev.kind === "callback" ||
            (ev.kind === "turn" && ev.status !== "started")) flush();
        else if (!frame) {
          frame = requestAnimationFrame(flush);
          timer = setTimeout(flush, 100);
        }
      });
      disconnect.current = () => {
        closed = true;
        close();
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", flush);
        pending = [];
      };
    };
    connect();
    // a fresh stream starts with a snapshot that replaces the history
    reconnect.current = () => { disconnect.current?.(); connect(); };
    return () => { disconnect.current?.(); disconnect.current = null; reconnect.current = null; };
  }, [sessionId, released]);

  const loadEarlier = useCallback(async () => {
    const before = stateRef.current.historyBeforeCursor;
    if (!sessionId || !before || released || pageBusy.current) return;
    pageBusy.current = true;
    try {
      const page = await getHistory(sessionId, before);
      if (identity.current !== sessionId) return;
      setState(s => {
        const ids = new Set(s.entries.map(e => e.id));
        return { ...s, entries: [...page.history.filter(e => !ids.has(e.id)), ...s.entries],
          historyBeforeCursor: page.historyBeforeCursor ?? null };
      });
    } catch (e) {
      if (identity.current === sessionId) setState(s => ({ ...s, error: String(e) }));
    } finally { pageBusy.current = false; }
  }, [sessionId, released]);

  // Returning an empty state immediately prevents one render with another session's turn ID.
  const current = identity.current === sessionId ? state : initialConversation();
  const resync = useCallback(() => reconnect.current?.(), []);
  return { ...current, loadEarlier, resync, disconnect: () => disconnect.current?.() };
}
