import * as React from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, RefreshCw, LogIn, Plug, X } from "lucide-react";
import { Button, Spinner } from "@/components/ui";
import "@/lib/windowControls";
import { SignInConfirmation } from "@/components/SignInConfirmation";
import { getTheme } from "@/lib/theme";
import { McpView } from "./McpView";

const LABELS: Record<string, string> = { work: "Mistral Work", skills: "Skills", knowledge: "Knowledge", connectors: "Connectors", libraries: "Libraries", instructions: "Instructions", scheduled: "Scheduled", docs: "Docs & API", admin: "Admin" };
export function WorkspaceView() {
  const { section = "work" } = useParams();
  const navigate = useNavigate();
  const [controlsHost, setControlsHost] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => { setControlsHost(document.getElementById("workspace-controls")); }, []);
  const area = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<{status:string; detail:string; section?:string}>({ status: "loading", detail: "" });
  const [revision, setRevision] = React.useState(0);
  const [signingIn, setSigningIn] = React.useState(false);
  const [connectingServices, setConnectingServices] = React.useState(false);
  const [localConnectors, setLocalConnectors] = React.useState(false);
  const showLocal = section === "connectors" && localConnectors;
  const isConnectors = showLocal || (state.section || section) === "connectors";
  const desktop = window.vibedeck?.workspace;
  React.useEffect(() => {
    if (!desktop || !area.current || !LABELS[section] || showLocal) return;
    let closed = false;
    const fail = () => { if (!closed) setState({ status: "error", detail: "The workspace could not open. Try Refresh or Sign in." }); };
    const rectangle = () => {
      const rect = area.current!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const unsubscribe = desktop.onState(setState);
    setState({ status: "loading", detail: "" });
    void desktop.open(section, rectangle(), getTheme() === "light" ? "light" : "dark").catch(fail);
    const observer = new ResizeObserver(() => { void desktop.resize(rectangle()).catch(fail); });
    observer.observe(area.current);
    return () => { closed = true; observer.disconnect(); unsubscribe(); void desktop.close().catch(() => {}); };
  }, [desktop, section, revision, showLocal]);
  const signIn = async (connectors = false) => {
    if (!desktop || signingIn) return;
    setSigningIn(true);
    setConnectingServices(connectors);
    try {
      if (!await (connectors ? desktop.connectServices() : desktop.signIn((state.section || section) === "admin" ? "admin" : "work"))) return;
      window.dispatchEvent(new Event("vibedeck:account-changed"));
      setLocalConnectors(false);
      const target = connectors ? "connectors" : state.section || section;
      if (target !== section) navigate("/workspace/" + target);
      else setRevision(value => value + 1);
    } catch { setState({ status: "error", detail: "Sign-in could not finish. Try again." }); }
    finally { setSigningIn(false); }
  };
  const accountWorkspace = showLocal || !["docs", "admin"].includes(state.section || section);
  const controls = <>
    {isConnectors && <Button variant="ghost" size="sm" aria-pressed={showLocal} title={showLocal ? "Show Mistral web connectors" : "Show local CLI connectors"} aria-label={showLocal ? "Show Mistral web connectors" : "Show local CLI connectors"} disabled={signingIn} onClick={() => { if (!showLocal) navigate("/workspace/connectors"); setLocalConnectors(!showLocal); }}><Plug size={14} />{showLocal ? "Mistral web" : "Local CLI"}</Button>}
    {accountWorkspace && <Button variant="ghost" size="sm" title="Connect services" aria-label="Connect services" disabled={!desktop || signingIn} onClick={() => void signIn(true)}><Plug size={14} /></Button>}
    <Button variant="ghost" size="sm" title="Back to desktop" aria-label="Back to desktop" disabled={signingIn} onClick={() => navigate("/")}><ArrowLeft size={14} /></Button>
    {!showLocal && <Button variant="ghost" size="sm" title="Refresh workspace" aria-label="Refresh" disabled={!desktop || signingIn} onClick={() => void desktop?.refresh().catch(() => setState({status:"error",detail:"Could not refresh. Try opening this page again."}))}><RefreshCw size={14} /></Button>}
    {(accountWorkspace || (state.section || section) === "admin") && <Button variant="ghost" size="sm" title={state.status === "ready" ? "Switch account" : "Sign in"} aria-label={state.status === "ready" ? "Switch account" : "Sign in"} disabled={!desktop || signingIn} onClick={() => void signIn()}><LogIn size={14} /></Button>}
  </>;
  return <div className="h-full flex flex-col">
    <h1 className="sr-only">{LABELS[showLocal ? "connectors" : state.section || section] || "Unknown workspace section"}</h1>
    {controlsHost ? createPortal(controls, controlsHost) : !window.vibedeck && <div className="flex gap-1 p-1">{controls}</div>}
    {signingIn && <div className="shrink-0 border-b border-border bg-sidebar p-4"><SignInConfirmation connectors={connectingServices} /></div>}
    {!signingIn && state.detail && <div role={state.status === "error" ? "alert" : "status"} className="shrink-0 flex items-center gap-3 border-b border-border bg-sidebar px-4 py-2 text-sm text-text-muted"><span className="flex-1">{state.detail}</span><Button variant="ghost" size="icon" aria-label="Dismiss workspace notice" onClick={() => setState(value => ({...value,detail:""}))}><X size={14} /></Button></div>}
    <div ref={area} className="flex-1 min-h-0 flex items-center justify-center bg-bg">
      {showLocal ? <McpView onManageWeb={() => setLocalConnectors(false)} /> : !desktop ? <p className="max-w-md p-6 text-sm text-text-muted">The integrated Mistral workspace requires the Electron desktop app. Launch VibeDeck from your applications menu.</p>
        : state.status === "loading" && <p className="flex items-center gap-2 text-sm text-text-muted"><Spinner />Opening your workspace...</p>}
    </div>
  </div>;
}
