import * as React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { ArrowUpRight, Check, Code2, Copy, ExternalLink, Puzzle, Terminal, Workflow } from "lucide-react";
import { MistralLogo } from "@/components/Logo";
import type { Health } from "@/lib/types";

function CopyCommand({ title, command }: { title: string; command: string }) {
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState(false);
  return <div className="min-w-0"><p className="mb-3 text-sm">{title}</p>
    <div className="flex items-center gap-3 rounded-xl border border-border-strong px-4 py-4">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-sm text-primary">{command}</code>
      <button type="button" aria-label={`Copy ${title}`} className="shrink-0 rounded text-text-muted hover:text-text" onClick={async () => {
        try { await navigator.clipboard.writeText(command); setCopied(true); setError(false); }
        catch { setError(true); }
      }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
    </div>
    <p role="status" className="mt-2 min-h-4 text-xs text-text-muted">{error ? "Clipboard unavailable. Select and copy the command above." : copied ? "Copied" : ""}</p>
  </div>;
}

export function ExtensionsView() {
  const { health } = useOutletContext<{ health: Health | null }>();
  return <div className="h-full overflow-y-auto px-6 py-8 lg:px-12">
    <div className="mx-auto max-w-5xl">
      <h1 className="text-2xl font-semibold tracking-tight">Extensions</h1>
      <p className="mt-1 text-sm text-text-muted">Extend your Vibe Code setup with tools for your workflow.</p>
      <h2 className="mt-12 mb-3 text-sm text-text-muted">Featured</h2>
      <section aria-label="Vibe CLI" className="rounded-2xl bg-surface p-6 lg:p-10">
        <div className="flex flex-wrap items-start justify-between gap-4"><MistralLogo size={48} />
          <div className="flex flex-wrap gap-5 text-sm">
            <a href="https://github.com/mistralai/mistral-vibe" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:underline">GitHub<ExternalLink size={14} /></a>
            <a href="https://docs.mistral.ai/vibe/code" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:underline">Documentation<ExternalLink size={14} /></a>
          </div>
        </div>
        <h2 className="mt-6 text-2xl font-semibold">Vibe CLI</h2><p className="mt-2 text-sm text-text-faint">By Mistral AI</p>
        <p className="mt-6 max-w-4xl text-sm leading-relaxed">Work on code from your terminal with the same sessions, tools, and configuration you use in VibeDeck. Review changes, explain a project, or continue a desktop conversation with the CLI handoff button.</p>
        <p className="mt-4 text-xs text-text-muted">{health?.vibe_cli ? "Vibe CLI is installed on this machine." : "Vibe CLI was not detected. Install it before starting a local session."}</p>
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <CopyCommand title="1. Install Vibe CLI" command="curl -LsSf https://mistral.ai/vibe/install.sh | bash" />
          <CopyCommand title="2. Set up Vibe CLI" command="vibe --setup" />
        </div>
        <details className="mt-5 text-sm"><summary className="w-fit cursor-pointer text-text-muted hover:text-text">Advanced</summary>
          <div className="mt-4 space-y-3 text-sm text-text-muted">
            <p>VibeDeck shares the CLI session store and configuration under <code>$VIBE_HOME</code>, which defaults to <code>~/.vibe</code>. Only one process can write to a session at a time.</p>
            <p>Finish or stop the current turn before choosing Continue in the Vibe CLI. Close the terminal session before resuming in desktop.</p>
            <p>For a cloud handoff, continue in the CLI and use <code>/teleport</code>. This is a one-way move to Vibe Code Web, requires an eligible Mistral account and a GitHub-connected repository, and does not support third-party models. Local Work chats stay local.</p>
            <a href="https://docs.mistral.ai/vibe/code/cli/teleport-cli-web" target="_blank" rel="noreferrer" className="inline-flex text-primary hover:underline">Read the cloud handoff requirements</a>
            <div className="flex flex-wrap gap-4"><Link to="/settings?section=config" className="text-primary hover:underline">CLI configuration</Link><Link to="/mcp" className="text-primary hover:underline">MCP servers</Link><Link to="/skills" className="text-primary hover:underline">Skills</Link></div>
          </div>
        </details>
      </section>
      <h2 className="mt-10 mb-3 text-sm text-text-muted">All</h2>
      <div className="grid gap-5 md:grid-cols-2">
        <a href="https://docs.mistral.ai/vibe/code/vs-code-extension/install-authenticate" target="_blank" rel="noreferrer" className="group rounded-2xl bg-surface p-6 transition-colors hover:bg-surface-muted">
          <div className="flex justify-between"><Code2 size={30} className="text-info" /><ArrowUpRight size={18} className="text-text-muted group-hover:text-text" /></div>
          <h3 className="mt-6 text-lg font-semibold">Visual Studio Code</h3><p className="mt-1 text-xs text-text-faint">By Mistral AI</p><p className="mt-5 text-sm leading-relaxed text-text-muted">Use Mistral's editor integration alongside Vibe CLI. Open the official Code guide for installation and supported session sharing.</p>
        </a>
        <a href="https://docs.mistral.ai/vibe/code/use-vibe-in-other-ides" target="_blank" rel="noreferrer" className="group rounded-2xl bg-surface p-6 transition-colors hover:bg-surface-muted">
          <div className="flex justify-between"><Workflow size={30} /><ArrowUpRight size={18} className="text-text-muted group-hover:text-text" /></div>
          <h3 className="mt-6 text-lg font-semibold">ACP</h3><p className="mt-1 text-xs text-text-faint">Agent Client Protocol</p><p className="mt-5 text-sm leading-relaxed text-text-muted">Connect Vibe to editors that support ACP. See the CLI documentation for supported clients and setup.</p>
        </a>
        <Link to="/mcp" className="rounded-2xl border border-border p-6 hover:bg-surface transition-colors"><Terminal size={25} /><h3 className="mt-5 text-lg font-semibold">Local MCP servers</h3><p className="mt-3 text-sm text-text-muted">See the tools already configured for your CLI.</p></Link>
        <Link to="/skills" className="rounded-2xl border border-border p-6 hover:bg-surface transition-colors"><Puzzle size={25} /><h3 className="mt-5 text-lg font-semibold">Skills</h3><p className="mt-3 text-sm text-text-muted">Browse the skills available to your local agent.</p></Link>
      </div>
    </div>
  </div>;
}
