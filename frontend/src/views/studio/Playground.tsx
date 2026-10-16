import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Square, Loader2, Trash2, Sparkles, Bot, SlidersHorizontal } from "lucide-react";
import { Button, Input, Select, Badge } from "@/components/ui";
import { streamChat, studioModels } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ModelInfo } from "@/lib/types";

interface Msg {
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
}

const REASONING_OPTIONS = [
  { value: "", label: "Default" },
  { value: "none", label: "Off" },
  { value: "high", label: "High" },
];
const REASONING_MODELS = new Set(["mistral-small-latest", "mistral-small-2603", "mistral-medium-3-5", "mistral-medium-latest", "mistral-large-4", "mistral-large-latest", "zai-glm-5-3"]);

export function Playground() {
  const [models, setModels] = React.useState<ModelInfo[]>([]);
  const [model, setModel] = React.useState("mistral-large-4");
  const [system, setSystem] = React.useState("");
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState("");
  const [temperature, setTemperature] = React.useState(0.7);
  const [maxTokens, setMaxTokens] = React.useState(1024);
  const [reasoning, setReasoning] = React.useState("");
  const [parametersOpen, setParametersOpen] = React.useState(true);
  const [topP, setTopP] = React.useState(1);
  const [seed, setSeed] = React.useState("");
  const [presence, setPresence] = React.useState(0);
  const [frequency, setFrequency] = React.useState(0);
  const [stops, setStops] = React.useState("");
  const [jsonMode, setJsonMode] = React.useState(false);
  const [safePrompt, setSafePrompt] = React.useState(false);
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const abortRef = React.useRef<(() => void) | null>(null);
  const generation = React.useRef(0);
  const sending = React.useRef(false);
  React.useEffect(() => () => { generation.current++; abortRef.current?.(); }, []);

  React.useEffect(() => {
    let closed = false;
    studioModels().then(d => {
      if (closed) return;
      setModels(d.models);
      if (d.models.length && !d.models.some(m => m.id === "mistral-large-4")) setModel(d.models[0].id);
    }).catch(() => { if (!closed) setError("Could not load Studio models. Check the Mistral Studio API key in Settings → Providers."); });
    return () => { closed = true; };
  }, []);

  // auto-grow the composer textarea, like the main chat composer
  React.useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 192) + "px";
  }, [input]);

  // Smooth-scroll only when a message is added; while streaming, jump
  // instantly so the smooth animation isn't restarted on every token.
  const prevCountRef = React.useRef(messages.length);
  React.useEffect(() => {
    const added = messages.length > prevCountRef.current;
    prevCountRef.current = messages.length;
    bottomRef.current?.scrollIntoView({ behavior: added && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
  }, [messages, streaming]);

  const send = async () => {
    const t = input.trim();
    if (!t || streaming || sending.current) return;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2 || !Number.isInteger(maxTokens) || maxTokens < 1) {
      setError("Enter a temperature from 0 to 2 and a positive maximum token count."); return;
    }
    if (!Number.isFinite(topP) || topP <= 0 || topP > 1 || ![presence, frequency].every(v => Number.isFinite(v) && v >= -2 && v <= 2)
      || (seed.trim() && (!Number.isInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > 4294967295))
      || stops.split("\n").filter(Boolean).length > 8) {
      setError("Check Top P (greater than 0, up to 1), penalties (−2 to 2), seed (0–4294967295), and stop sequences (up to 8)."); return;
    }
    sending.current = true;
    const token = ++generation.current;
    setInput("");
    setError(null);
    const userMsg: Msg = { role: "user", content: t };
    const assistantMsg: Msg = { role: "assistant", content: "", thinking: "" };
    setMessages((m) => [...m, userMsg, assistantMsg]);
    setStreaming(true);

    const history = messages.filter(m => m.content.trim()).map((m) => ({ role: m.role, content: m.content }));
    abortRef.current = streamChat(
      {
        message: t, model, messages: history, system_prompt: system || undefined,
        reasoning_effort: reasoning || undefined,
        temperature, max_tokens: maxTokens,
        top_p: topP, random_seed: seed.trim() ? Number(seed) : undefined,
        presence_penalty: presence, frequency_penalty: frequency,
        stop: stops.split("\n").filter(Boolean), json_mode: jsonMode, safe_prompt: safePrompt,
      },
      {
        onDelta: (stream, text) => {
          if (generation.current !== token) return;
          setMessages((m) => {
            const next = [...m];
            const last = next[next.length - 1];
            if (!last) return m;
            if (stream === "think") last.thinking = (last.thinking || "") + text;
            else last.content += text;
            return next;
          });
        },
        onError: err => { if (generation.current === token) { setError(err); setStreaming(false); sending.current = false; } },
        onDone: () => { if (generation.current === token) { setStreaming(false); sending.current = false; window.dispatchEvent(new Event("vibedeck:usage-refresh")); } },
      },
    );
  };

  const stop = () => { generation.current++; abortRef.current?.(); setStreaming(false); sending.current = false; window.dispatchEvent(new Event("vibedeck:usage-refresh")); };
  const clear = () => { stop(); setMessages([]); setError(null); };

  const modelOptions = models.length
    ? models.map((m) => ({ value: m.id, label: m.id }))
    : [{ value: model, label: model }];

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        <Select aria-label="Studio model" value={model} disabled={streaming} onChange={value => { setModel(value); setReasoning(""); }} options={modelOptions} className="font-mono max-w-[220px] h-8" />
        <span className="text-xs text-text-faint">Mistral API · billed separately from Vibe</span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={clear}><Trash2 size={13} /> Clear</Button>
        <Button variant="outline" size="sm" aria-expanded={parametersOpen} aria-controls="studio-parameters" onClick={() => setParametersOpen(open => !open)}><SlidersHorizontal size={14} /> Parameters</Button>
      </div>
      <div className="flex flex-1 min-h-0">
      <div className="flex flex-1 min-w-0 flex-col">
      {/* messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <div className="h-full grid place-items-center text-text-faint text-sm">
            <div className="text-center">
              <Sparkles size={20} className="mx-auto mb-2 text-primary" />
              Studio Playground — pick a model and send a prompt.
            </div>
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((m, i) => (
            <div key={i} className={cn("flex gap-3", m.role === "user" ? "justify-end" : "")}>
              {m.role === "assistant" && (
                <div className="h-7 w-7 shrink-0 rounded-full bg-primary/15 text-primary grid place-items-center">
                  <Bot size={14} />
                </div>
              )}
              <div className={cn("min-w-0 max-w-[85%]", m.role === "user" && "flex justify-end")}>
                {m.thinking && (
                  <details className="mb-1 text-xs text-text-muted">
                    <summary className="cursor-pointer">Thinking</summary>
                    <div className="mt-1 whitespace-pre-wrap border-l border-border pl-2">{m.thinking}</div>
                  </details>
                )}
                {m.role === "user" ? (
                  <div className="rounded-lg bg-surface-muted px-3 py-2 text-sm whitespace-pre-wrap">{m.content}</div>
                ) : (
                  <div className="prose-vd">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          ))}
          {streaming && messages[messages.length - 1]?.role === "assistant" && !messages[messages.length - 1]?.content && (
            <div className="flex items-center gap-2 text-xs text-text-muted pl-10">
              <Loader2 size={13} className="animate-spin text-primary" /> generating…
            </div>
          )}
          {error && <div className="text-xs text-danger">{error}</div>}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* composer — same design language as the main chat composer */}
      <div className="shrink-0 border-t border-border px-6 py-4">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-2xl border border-border bg-surface shadow-sm transition-colors focus-within:border-border-strong">
            <textarea
              ref={taRef}
              aria-label="Playground message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); streaming ? stop() : send(); } }}
              placeholder="Send a message to the model…"
              rows={1}
              className="w-full bg-transparent px-4 pt-3.5 pb-1 text-[15px] text-text placeholder:text-text-faint resize-none focus:outline-none max-h-48"
              style={{ minHeight: 26 }}
            />
            <div className="flex items-center gap-1 px-2 pb-2">
              <div className="flex-1" />
              {streaming ? (
                <button
                  type="button"
                  onClick={stop}
                  title="Stop"
                  aria-label="Stop"
                  className="h-8 w-8 shrink-0 grid place-items-center rounded-full vd-send transition-colors"
                >
                  <Square size={13} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={send}
                  disabled={!input.trim()}
                  title="Send (Enter)"
                  aria-label="Send"
                  className="h-8 w-8 shrink-0 grid place-items-center rounded-full vd-send disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 px-1">
            <Badge tone="primary">{model}</Badge>
            <span className="text-[11px] text-text-faint">API-billed · streams live</span>
          </div>
        </div>
      </div>
      </div>
      <aside id="studio-parameters" aria-label="Generation parameters" aria-hidden={!parametersOpen} className={cn("shrink-0 overflow-hidden transition-[width] duration-200 motion-reduce:transition-none", parametersOpen ? "w-60 border-l border-border" : "w-0")}>
        {parametersOpen && <fieldset disabled={streaming} className="w-60 h-full overflow-y-auto p-4 space-y-4 text-xs text-text-muted">
          <h2 className="text-sm font-medium text-text">Parameters</h2>
          <label className="block">System prompt
            <textarea aria-label="System prompt" value={system} onChange={e => setSystem(e.target.value)} placeholder="Optional instructions for every request" rows={3} className="mt-2 w-full resize-y rounded-md border border-border bg-bg p-2 text-text focus:outline-primary" />
          </label>
          <label className="block">Reasoning
            <Select aria-label="Studio reasoning" className="mt-2 w-full" value={reasoning} onChange={setReasoning} disabled={!REASONING_MODELS.has(model)} options={model === "zai-glm-5-3" ? [{value:"",label:"Default"},{value:"low",label:"Low"},{value:"high",label:"High"},{value:"max",label:"Max"}] : REASONING_OPTIONS} />
          </label>
          <label className="block">Temperature
            <Input aria-label="Temperature" type="number" step={0.1} min={0} max={2} value={temperature} onChange={e => setTemperature(Number.parseFloat(e.target.value))} className="mt-2" />
          </label>
          <label className="block">Max tokens
            <Input aria-label="Max tokens" type="number" step={128} min={1} value={maxTokens} onChange={e => setMaxTokens(Number.parseInt(e.target.value))} className="mt-2" />
          </label>
          <label className="block">Top P
            <Input aria-label="Top P" type="number" step={0.05} min={0.01} max={1} value={topP} disabled={temperature === 0} onChange={e => setTopP(Number.parseFloat(e.target.value))} className="mt-2" />
          </label>
          <p className="text-text-faint">Change temperature or Top P. Temperature 0 uses Top P 1 for greedy sampling.</p>
          <label className="block">Random seed
            <Input aria-label="Random seed" type="number" min={0} max={4294967295} step={1} value={seed} onChange={e => setSeed(e.target.value)} placeholder="Random" className="mt-2" />
          </label>
          <label className="block">Presence penalty
            <Input aria-label="Presence penalty" type="number" min={-2} max={2} step={0.1} value={presence} onChange={e => setPresence(Number.parseFloat(e.target.value))} className="mt-2" />
          </label>
          <label className="block">Frequency penalty
            <Input aria-label="Frequency penalty" type="number" min={-2} max={2} step={0.1} value={frequency} onChange={e => setFrequency(Number.parseFloat(e.target.value))} className="mt-2" />
          </label>
          <label className="block">Stop sequences
            <textarea aria-label="Stop sequences" value={stops} onChange={e => setStops(e.target.value)} placeholder="One per line (up to 8)" rows={2} className="mt-2 w-full resize-y rounded-md border border-border bg-bg p-2 text-text focus:outline-primary" />
          </label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={jsonMode} onChange={e => setJsonMode(e.target.checked)} /> JSON output</label>
          {jsonMode && <p className="text-text-faint">Reaching Max tokens can truncate JSON. Allow enough tokens for the complete object.</p>}
          <label className="flex items-center gap-2"><input type="checkbox" checked={safePrompt} onChange={e => setSafePrompt(e.target.checked)} /> Mistral safety prompt</label>
          <p className="text-text-faint">Parameters apply on Send. Changing a setting never generates a request.</p>
        </fieldset>}
      </aside>
      </div>
    </div>
  );
}
