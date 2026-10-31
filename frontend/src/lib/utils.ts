import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const MODEL_WORDS: Record<string, string> = {
  glm: "GLM", gpt: "GPT", ocr: "OCR", api: "API", deepseek: "DeepSeek", openai: "OpenAI",
  qwen: "Qwen", kimi: "Kimi", moonshot: "Moonshot", mini: "Mini", nano: "Nano", oss: "OSS",
};
const MODEL_VENDOR_PREFIXES = new Set(["zai", "openai", "anthropic", "google", "mistralai", "moonshotai"]);

/**
 * Human model name: the registry's display name when it has one, otherwise a
 * readable form of the alias ("devstral-medium-2-1" → "Devstral Medium 2.1",
 * "zai-glm-5-3-flash" → "GLM 5.3 Flash").
 */
export function modelLabel(id: string, name?: string | null): string {
  if (name && name !== id) return name;
  if (!id) return "";
  const parts = id.split("/").pop()!.split(/[-_\s]+/).filter(Boolean);
  if (parts.length > 1 && MODEL_VENDOR_PREFIXES.has(parts[0].toLowerCase())) parts.shift();
  const out: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (/^\d+(\.\d+)*$/.test(part) && out.length && /^\d+(\.\d+)*$/.test(out[out.length - 1]) && part.length <= 2) {
      out[out.length - 1] += `.${part}`;
    } else if (lower === "latest") {
      out.push("(latest)");
    } else {
      out.push(MODEL_WORDS[lower] || (/^\d/.test(part) ? part : part[0].toUpperCase() + part.slice(1)));
    }
  }
  return out.join(" ");
}

export function formatTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(promptTok: number, completionTok: number, inPrice: number, outPrice: number): string {
  const cost = (promptTok * inPrice) / 1e6 + (completionTok * outPrice) / 1e6;
  if (!cost) return "—";
  return `$${cost.toFixed(4)}`;
}

export function timeAgo(ts: number): string {
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
