import * as React from "react";
import { useOutletContext, useNavigate, useSearchParams } from "react-router-dom";
import {
  Calendar, Compass, ListChecks, Mail,
  MoreHorizontal, ShieldAlert, Sparkles,
} from "lucide-react";
import { Composer, type ImageAttachment } from "@/components/Composer";
import { MistralLogo } from "@/components/Logo";
import { ProjectPicker, rememberCwd } from "@/components/ProjectPicker";
import { BranchPicker } from "@/components/BranchPicker";
import { LANE_AGENT } from "@/hooks/useSessions";
import { patchSession, sendTurn } from "@/lib/api";
import type { Lane } from "@/lib/types";

interface Ctx {
  lane: Lane;
  sessions: unknown[];
  health: { default_model: string; default_agent: string; user?: string } | null;
  config: { defaultModel: string; defaultAgent: string } | null;
}

/** Suggestion cards pinned near the bottom of the code lane, like the webapp. */
const CARDS = [
  { icon: Compass, label: "Explain how this project is structured" },
  { icon: ListChecks, label: "Identify outdated or unused dependencies" },
  { icon: ShieldAlert, label: "Check for common security risks" },
];

/** Suggestion chips under the composer in the work lane, like the webapp. */
const WORK_CHIPS = [
  { icon: Sparkles, label: "What's new in Vibe" },
  { icon: Calendar, label: "Brief me on my next meeting" },
  { icon: Mail, label: "Summarize my unread emails and draft responses" },
];

/** Greeting + closing line, matching the webapp's time-of-day variants. */
function greeting(): { label: string; suffix: string } {
  const h = new Date().getHours();
  if (h < 5 || h >= 23) return { label: "Late night", suffix: "ready to chat?" };
  if (h < 12) return { label: "Morning", suffix: "what needs doing?" };
  if (h < 18) return { label: "Afternoon", suffix: "what needs doing?" };
  return { label: "Evening", suffix: "ready to chat?" };
}

export function Welcome() {
  const { lane, health, config } = useOutletContext<Ctx>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [cwd, setCwd] = React.useState(localStorage.getItem("vibedeck.cwd") || "");
  React.useEffect(() => { if (params.has("project")) setCwd(params.get("project") || ""); }, [params]);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const pending = React.useRef<{ id: string; requestId: string; payload: string; cwd: string; lane: Lane; agent: string; model: string } | null>(null);
  const sending = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [model, setModel] = React.useState(
    config?.defaultModel || health?.default_model || "mistral-large-4");
  React.useEffect(() => { if (config?.defaultModel) setModel(config.defaultModel); }, [config?.defaultModel]);
  const defaultAgent = lane === "code" ? config?.defaultAgent || LANE_AGENT.code : LANE_AGENT.work;
  const [agent, setAgent] = React.useState(defaultAgent);

  // Work starts in ask mode; Code honors the saved default.
  React.useEffect(() => { setAgent(defaultAgent); }, [defaultAgent]);

  const name = (health?.user || "there").replace(/^./, (c) => c.toUpperCase());

  const start = async (prompt: string, images: ImageAttachment[]) => {
    const p = prompt.trim();
    if ((!p && images.length === 0) || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const payload = JSON.stringify([p, images]);
      if (!pending.current) {
        localStorage.setItem("vibedeck.cwd", cwd || "");
        rememberCwd(cwd || "");
        const res = await fetch("/api/sessions", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: cwd || undefined, lane, agent, model }),
        });
        if (!res.ok) throw new Error(await res.text());
        const s = await res.json();
        pending.current = { id: s.id, requestId: crypto.randomUUID(), payload, cwd, lane, agent, model };
      }
      const session = pending.current;
      if (session.cwd !== cwd || session.lane !== lane) {
        throw new Error("This session started in another project or mode. Open it to continue, or start a new session.");
      }
      if (session.agent !== agent || session.model !== model) {
        const updated = await patchSession(session.id, { agent, model });
        session.agent = updated.agent || agent;
        session.model = updated.model || model;
      }
      // Configuration changes do not change the identity of a possibly accepted message.
      if (session.payload !== payload) {
        session.payload = payload;
        session.requestId = crypto.randomUUID();
      }
      await sendTurn(session.id, p, images, session.requestId);
      navigate(`/sessions/${session.id}`);
    } catch (e) {
      setError(`Failed to start session: ${e}`);
      throw e;
    } finally { sending.current = false; setBusy(false); }
  };

  return (
    <div className="h-full overflow-y-auto">
      <fieldset
        disabled={busy}
        aria-busy={busy || undefined}
        className={`h-full min-h-fit min-w-0 flex flex-col border-0 p-0 m-0 ${lane === "work" ? "pb-16" : ""}`}
      >
        {/* centered block: logo, greeting, composer */}
        <div className="my-auto w-full max-w-3xl mx-auto px-6 py-8">
          <MistralLogo size={40} className="vd-reveal mb-5" />
          <h1
            className="text-[30px] font-medium tracking-tight text-text mb-6 vd-reveal"
            style={{ animationDelay: "70ms" }}
          >
            {lane === "work"
              ? `${greeting().label}, ${name}, ready to focus on work?`
              : `${greeting().label}, ready to review some code?`}
          </h1>
          <div className="relative z-10 vd-reveal" style={{ animationDelay: "140ms" }}>
            <Composer
              value={text}
              onChange={setText}
              onSend={start}
              disabled={busy}
              sendError={error}
              placeholder={lane === "code" ? "What do you want to build?" : "Type / for quick access"}
              model={model}
              onModelChange={setModel}
              agent={agent}
              onAgentChange={setAgent}
              extraLeft={<><ProjectPicker cwd={cwd} onChange={setCwd} /><BranchPicker cwd={cwd} /></>}
              footer={error && pending.current ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 px-1 text-xs">
                  <button type="button" onClick={() => navigate(`/sessions/${pending.current!.id}`)} className="rounded-md border border-border px-2 py-1 hover:bg-surface-muted">Open created session</button>
                  <button type="button" onClick={() => { pending.current = null; setError(null); }} className="rounded-md border border-border px-2 py-1 hover:bg-surface-muted">Start new session</button>
                </div>
              ) : undefined}
            />
          </div>

          {/* work lane: suggestion chips stacked under the composer, left-aligned
              with it — exactly like the webapp */}
          {lane === "work" && (
            <div className="mt-4 flex flex-col items-start gap-1 vd-reveal" style={{ animationDelay: "210ms" }}>
              {WORK_CHIPS.map((c, i) => (
                <button
                  key={c.label}
                  onClick={() => setText(c.label)}
                  className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-text-muted transition-colors hover:bg-surface-muted hover:text-text vd-reveal"
                  style={{ animationDelay: `${210 + i * 60}ms` }}
                >
                  <c.icon size={13} className="shrink-0" />
                  {c.label}
                </button>
              ))}
              <button
                onClick={() => setText("")}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-text-faint transition-colors hover:bg-surface-muted hover:text-text-muted vd-reveal"
                style={{ animationDelay: "390ms" }}
              >
                <MoreHorizontal size={13} className="shrink-0" />
                Discover more
              </button>
            </div>
          )}
        </div>

        {/* code lane: suggestion cards near the bottom edge, like the webapp */}
        {lane === "code" && (
          <div className="w-full max-w-3xl mx-auto px-6 pb-6">
            <div className="flex gap-3 overflow-x-auto">
              {CARDS.map((c, i) => (
                <button
                  key={c.label}
                  onClick={() => setText(c.label)}
                  className="flex-1 min-w-[200px] rounded-xl border border-border bg-surface px-4 py-3.5 text-left transition-colors hover:border-border-strong hover:bg-surface-raised hover:text-text text-text-muted vd-reveal"
                  style={{ animationDelay: `${210 + i * 70}ms` }}
                >
                  <c.icon size={16} className="block mb-2.5" />
                  <span className="block text-sm leading-snug">{c.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </fieldset>
    </div>
  );
}
