/**
 * VibeDeck themes. Themes are pure CSS-variable sets keyed by a
 * `data-theme` attribute on <html> (see index.css); this module owns the
 * id list, persistence (localStorage), and applying the attribute.
 */

export type ThemeId = "dark" | "light" | "midnight" | "dim" | "forest" | "plum" | "contrast";

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  description: string;
  /** swatch colors for the settings picker (hex, for inline styles) */
  swatch: { bg: string; surface: string; text: string; primary: string };
}

export const THEMES: ThemeInfo[] = [
  {
    id: "dark",
    name: "Dark",
    description: "Charcoal with Mistral orange, matching the web app.",
    swatch: { bg: "#19191b", surface: "#252527", text: "#f2f2f2", primary: "#ff4400" },
  },
  {
    id: "light",
    name: "Light",
    description: "Warm off-white paper with the signature orange.",
    swatch: { bg: "#faf8f3", surface: "#ffffff", text: "#1a1a1a", primary: "#ff6b00" },
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Deep blue-black, easy on the eyes at night.",
    swatch: { bg: "#0a0f1a", surface: "#141c2e", text: "#e8eef7", primary: "#ff7a1a" },
  },
  {
    id: "dim",
    name: "Dim",
    description: "Softer dark — lower contrast, relaxed.",
    swatch: { bg: "#141312", surface: "#1f1d1b", text: "#e0ddd8", primary: "#ff6b00" },
  },
  { id: "forest", name: "Forest", description: "Deep green with a mint accent.", swatch: {bg:"#101914",surface:"#1a241e",text:"#eff5f1",primary:"#61d1a7"} },
  { id: "plum", name: "Plum", description: "Soft purple with a violet accent.", swatch: {bg:"#1a151f",surface:"#2b2334",text:"#f5f3f8",primary:"#c08df2"} },
  { id: "contrast", name: "High contrast", description: "Black, white and amber with clear borders.", swatch: {bg:"#000000",surface:"#0d0d0d",text:"#ffffff",primary:"#ffb833"} },
];

const STORAGE_KEY = "vibedeck.theme";

export function getTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.some((t) => t.id === saved)) return saved as ThemeId;
  } catch { /* storage unavailable */ }
  return "dark";
}

/** Apply the theme attribute to <html> (no persistence). */
export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
}

/** Persist + apply. */
export function setTheme(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch { /* storage unavailable */ }
  applyTheme(id);
}

/** Install the saved theme before first paint (call from main.tsx). */
export function initTheme(): void {
  applyTheme(getTheme());
}
