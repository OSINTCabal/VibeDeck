import * as React from "react";
import { McpView } from "./McpView";
import { BookOpen, Clock3, ExternalLink, FileText, Plug, RefreshCw, Search, Sparkles } from "lucide-react";
import { createWorkspaceLibrary, getWorkspace } from "@/lib/api";
import { Button, Input, Spinner } from "@/components/ui";

const SECTIONS = {
  knowledge: { title: "Knowledge", description: "What Mistral remembers from your work.", icon: Sparkles,
    detail: "Review, update, or clean up your Knowledge in your Mistral web workspace.", url: "https://chat.mistral.ai/knowledge" },
  libraries: { title: "Libraries", description: "Documents and references for your Mistral workspace.", icon: BookOpen,
    detail: "Create a shared library here, then open it in Mistral web to add documents and manage access. Use the same workspace in your browser and API key. Local CLI files are separate.", url: "https://chat.mistral.ai/libraries" },
  connectors: { title: "Connectors", description: "External connections visible through your Mistral API key.", icon: Plug,
    detail: "Manage Mistral connections in the desktop's web workspace, including their service authorization. Local CLI MCP servers are listed below and share Vibe's configuration.", url: "https://chat.mistral.ai/connections" },
  instructions: { title: "Instructions", description: "Set how Mistral should respond in your web workspace.", icon: FileText,
    detail: "Open Mistral Work and choose Context → Instructions to edit your preferences. Web instructions do not replace the CLI's project instructions.", url: "https://chat.mistral.ai/work" },
  scheduled: { title: "Scheduled", description: "Recurring tasks and prompts for later.", icon: Clock3,
    detail: "Create, pause, or edit tasks in your Mistral web workspace. Tasks run there on your selected schedule.", url: "https://chat.mistral.ai/tasks" },
};

export type WorkSection = keyof typeof SECTIONS;

export function WorkContextView({ section }: { section: WorkSection }) {
  const page = SECTIONS[section];
  const [items, setItems] = React.useState<Awaited<ReturnType<typeof getWorkspace>>["items"]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [revision, setRevision] = React.useState(0);
  const [adding, setAdding] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [createError, setCreateError] = React.useState("");
  const [created, setCreated] = React.useState("");
  const resource = section === "connectors" || section === "libraries" ? section : null;
  React.useEffect(() => {
    if (!resource) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setItems([]);
    getWorkspace(resource, controller.signal).then(data => {
      if (!controller.signal.aborted) setItems(data.items);
    }).catch(error => {
      if (!controller.signal.aborted) setError(String(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [resource, revision]);
  const visible = items.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="h-full overflow-y-auto px-6 py-8 lg:px-12">
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-2xl font-semibold tracking-tight">{page.title}</h1><p className="mt-1 text-sm text-text-muted">{page.description}</p></div>
        <a href={page.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm hover:bg-surface-muted transition-colors">Open Mistral {section === "instructions" ? "Work" : section === "scheduled" ? "Tasks" : page.title}<ExternalLink size={14} /></a>
      </div>
      <p className="mt-6 rounded-lg border border-border bg-surface/50 px-4 py-3 text-sm leading-relaxed text-text-muted">{page.detail}</p>
      {resource ? <>
        {section === "libraries" && <div className="mt-6">
          <Button variant="outline" aria-expanded={adding} onClick={() => setAdding(value => !value)} disabled={creating}>New library</Button>
          {adding && <form aria-label="Create shared library" className="mt-4 space-y-3 rounded-xl border border-border p-4" onSubmit={async event => {
            event.preventDefault();
            if (creating || !name.trim()) return;
            setCreating(true); setCreateError(""); setCreated("");
            try {
              const library = await createWorkspaceLibrary(name.trim(), description.trim());
              setCreated(library.id); setAdding(false); setName(""); setDescription(""); setQuery("");
              setRevision(value => value + 1);
            } catch (error) { setCreateError(String(error)); }
            finally { setCreating(false); }
          }}>
            <label className="block text-sm">Library name<Input required maxLength={256} value={name} onChange={event => setName(event.target.value)} className="mt-1 w-full" disabled={creating} /></label>
            <label className="block text-sm">Description<Input maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} className="mt-1 w-full" disabled={creating} /></label>
            <p className="text-xs text-text-muted">Creates an empty library shared with the API key's workspace. Files stay local until you upload them.</p>
            <Button type="submit" disabled={creating || !name.trim()}>{creating ? "Creating..." : "Create shared library"}</Button>
          </form>}
          {createError && <p role="alert" className="mt-3 text-sm text-danger">{createError}</p>}
          {created && <p role="status" className="mt-3 text-sm text-text-muted">Library created. <a href={`https://chat.mistral.ai/libraries/${encodeURIComponent(created)}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">Open created library in Mistral</a></p>}
        </div>}
        <div className="my-6 flex items-center gap-3">
          <div className="relative flex-1"><Search size={15} className="absolute left-3 top-3 text-text-faint" /><Input aria-label={`Search ${section}`} placeholder={`Search ${section}...`} value={query} onChange={event => setQuery(event.target.value)} className="w-full pl-9" /></div>
          <Button variant="outline" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />Refresh</Button>
        </div>
        <p className="mb-4 text-xs text-text-faint">Only items visible to your configured Mistral API key are listed. Its workspace may differ from your browser account. Web content is not automatically available in CLI chats.</p>
        {section === "connectors" && <p className="mb-4 text-sm text-text-muted">Missing entries here do not mean they are disconnected on the web. Web sign-in and API authentication can differ. Check your API key's workspace and connector access scope, or open Mistral Connectors above to see your web connections.</p>}
        {loading && <p role="status" className="flex items-center gap-2 text-sm text-text-muted"><Spinner />Loading {section}...</p>}
        {error && <p role="alert" className="rounded-lg border border-danger/30 p-4 text-sm text-danger">{error}</p>}
        {!loading && !error && <>
          <p className="mb-4 text-xs text-text-muted">{visible.length} {section === "connectors" ? "API-visible connectors" : "libraries"}</p>
          <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
            {visible.map(item => <div key={item.id} className="flex items-start gap-3 rounded-lg p-3 hover:bg-surface transition-colors">
              <page.icon size={18} className="mt-0.5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1"><p className="text-sm font-medium break-words">{item.name}</p><p className="mt-1 text-xs leading-relaxed text-text-muted break-words">{item.description}</p>
                {section === "libraries" && item.documents != null && <p className="mt-2 text-xs text-text-faint">{item.documents} documents</p>}
                {section === "libraries" && <a href={`https://chat.mistral.ai/libraries/${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">Open in Mistral<ExternalLink size={12} /></a>}
              </div>
              {section === "connectors" && <span className={`shrink-0 text-xs ${item.connected ? "text-success" : "text-text-muted"}`}>{item.connected ? "Connected via API" : "Configured"}</span>}
            </div>)}
          </div>
          {!visible.length && <p className="py-8 text-sm text-text-muted">{query ? "No matching items." : section === "connectors" ? "No authenticated external connectors returned for this API key. Your web connections may still be active." : "No libraries returned for this API account. Check your workspace in the web app."}</p>}
        </>}
      </> : <div className="mt-8 flex items-start gap-4 rounded-xl border border-border bg-surface p-6">
        <page.icon size={24} className="shrink-0 text-primary" />
        <div><h2 className="font-medium">In your Mistral web workspace</h2><p className="mt-2 max-w-xl text-sm leading-relaxed text-text-muted">Use the link above to manage {section === "scheduled" ? "scheduled tasks" : section} with your existing Mistral account.</p></div>
      </div>}
      {section === "connectors" && <McpView embedded />}
    </div>
  </div>;
}
