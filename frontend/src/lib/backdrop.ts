/**
 * Animated app backgrounds: which one is chosen (kept in localStorage, like
 * the theme) and the mood the open view asks for. An empty screen shows the
 * background in full; a conversation with messages calms it and clears the
 * reading column; a working model quickens it.
 */
import * as React from "react";

export type BackdropId = "off" | "blocks" | "strings" | "mosaic" | "sunset";
export type BackdropMood = "idle" | "chat" | "working" | "page";

export const BACKDROPS: { id: BackdropId; name: string; description: string }[] = [
  { id: "off", name: "Off", description: "The plain theme background." },
  { id: "blocks", name: "Blocks", description: "Orange and yellow squares that tip into diamonds at the edges." },
  { id: "strings", name: "Strings", description: "Faint arcs with sparks travelling along them." },
  { id: "mosaic", name: "Mosaic", description: "Pixel tiles fading in and out, green and blue." },
  { id: "sunset", name: "Sunset", description: "Pixel bands from yellow to red along the bottom." },
];

const STORAGE_KEY = "vibedeck.backdrop";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

let backdrop: BackdropId = (() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && BACKDROPS.some(b => b.id === saved)) return saved as BackdropId;
  } catch { /* storage unavailable */ }
  return "off";
})();
let mood: BackdropMood | null = null;

export function setBackdrop(id: BackdropId): void {
  backdrop = id;
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* storage unavailable */ }
  emit();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const useBackdrop = () => React.useSyncExternalStore(subscribe, () => backdrop);
export const useBackdropMood = () => React.useSyncExternalStore(subscribe, () => mood);

/** The view on screen sets the mood while it is mounted; otherwise the shell picks one. */
export function useSetBackdropMood(next: BackdropMood): void {
  React.useEffect(() => {
    mood = next;
    emit();
  }, [next]);
  React.useEffect(() => () => { mood = null; emit(); }, []);
}
