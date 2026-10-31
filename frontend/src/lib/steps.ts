import type { HistoryEntry } from "./types";

/** A run of entries rendered either alone or folded into one summary row. */
export type StepItem =
  | { kind: "entry"; entry: HistoryEntry }
  | { kind: "group"; entries: HistoryEntry[] };

/**
 * Fold consecutive tool calls into one group, like the webapp's
 * "Ran 4 commands · Read theme.rs and 2 more" row. A lone tool call
 * stays a single entry.
 */
export function groupSteps(entries: HistoryEntry[]): StepItem[] {
  const items: StepItem[] = [];
  let run: HistoryEntry[] = [];
  const flush = () => {
    if (run.length > 1) items.push({ kind: "group", entries: run });
    else if (run.length === 1) items.push({ kind: "entry", entry: run[0] });
    run = [];
  };
  for (const entry of entries) {
    // a "!command" the user ran stays on its own, outside the agent's steps
    if (entry.type === "effect" && !isManualShell(entry)) run.push(entry);
    else { flush(); items.push({ kind: "entry", entry }); }
  }
  flush();
  return items;
}

export function isManualShell(e: HistoryEntry): boolean {
  return e.type === "effect" && e.detail?.kind === "shell" && !e.turnId;
}

export function toolName(e: HistoryEntry): string {
  return String(e.detail?.toolName || e.title || "tool");
}

/** The file a tool call touched, when its input names one. */
function toolPath(e: HistoryEntry): string | null {
  const input = e.detail?.input;
  const path = input && typeof input === "object" ? input.path || input.file_path || input.filePath : null;
  return typeof path === "string" && path ? path.split("/").pop() || path : null;
}

type Kind = "command" | "read" | "edit" | "search" | "other";

function kindOf(name: string): Kind {
  const n = name.toLowerCase();
  if (/bash|shell|exec|command|run/.test(n)) return "command";
  if (/grep|search|find|glob|list/.test(n)) return "search";
  if (/write|edit|patch|replace|create/.test(n)) return "edit";
  if (/read|view|open|cat/.test(n)) return "read";
  return "other";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function files(entries: HistoryEntry[], verb: string, fallback: string): string {
  const names = [...new Set(entries.map(toolPath).filter((p): p is string => !!p))];
  if (!names.length) return `${verb} ${plural(entries.length, fallback, fallback + "s")}`;
  if (names.length === 1) return `${verb} ${names[0]}`;
  if (names.length === 2) return `${verb} ${names[0]} and ${names[1]}`;
  return `${verb} ${names[0]} and ${names.length - 1} more`;
}

/** One-line summary of a group, in the order the kinds first appear. */
export function summarizeSteps(entries: HistoryEntry[]): string {
  const byKind = new Map<Kind, HistoryEntry[]>();
  for (const e of entries) {
    const k = kindOf(toolName(e));
    byKind.set(k, [...(byKind.get(k) || []), e]);
  }
  return [...byKind].map(([kind, list]) => {
    if (kind === "command") return `Ran ${plural(list.length, "command", "commands")}`;
    if (kind === "read") return files(list, "Read", "file");
    if (kind === "edit") return files(list, "Edited", "file");
    if (kind === "search") return `Searched ${plural(list.length, "time", "times")}`;
    return `Used ${plural(list.length, "tool", "tools")}`;
  }).join(" · ");
}

export function stepStatus(e: HistoryEntry): "running" | "failed" | "done" {
  const status = e.state?.status || "running";
  if (status === "running" || status === "in_progress") return "running";
  if (status === "failed" || status === "error") return "failed";
  return "done";
}

/** Seconds between an entry's creation and last update (timestamps in s or ms). */
export function durationSeconds(e: HistoryEntry): number | null {
  const { createdAt, updatedAt } = e;
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || updatedAt < createdAt) return null;
  const scale = createdAt > 1e12 ? 1000 : 1;
  return Math.round((updatedAt - createdAt) / scale);
}
