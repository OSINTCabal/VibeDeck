import * as React from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { PanelLeft, Settings } from "lucide-react";
import { SignInConfirmation } from "./SignInConfirmation";
import { Sidebar } from "./Sidebar";
import { TitleBar } from "./TitleBar";
import { CommandPalette } from "./CommandPalette";
import { Button, Spinner } from "./ui";
import { useSessions, useHealth, useAppConfig, normalizeLane } from "@/hooks/useSessions";
import type { Lane } from "@/lib/types";

export function AppShell() {
  const [lane, setLane] = React.useState<Lane>(() => {
    return normalizeLane(localStorage.getItem("vibedeck.lane") || "code");
  });
  const [collapsed, setCollapsed] = React.useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const inWorkspace = location.pathname.startsWith("/workspace/");
  const { sessions, create, remove, loading, error } = useSessions();
  const health = useHealth();
  const { config } = useAppConfig();
  const [welcome, setWelcome] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [signInError, setSignInError] = React.useState<string | null>(null);
  const welcomeRef = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const desktop = window.vibedeck?.usage;
    if (!desktop || localStorage.getItem("vibedeck.mistral-welcome") === "done") return;
    let closed = false;
    void desktop.account().then(account => {
      if (closed) return;
      if (account.remembered) localStorage.setItem("vibedeck.mistral-welcome", "done");
      else setWelcome(true);
    }).catch(() => { if (!closed) setWelcome(true); });
    return () => { closed = true; };
  }, []);
  React.useEffect(() => { if (welcome) welcomeRef.current?.showModal(); }, [welcome]);
  const dismissWelcome = () => {
    if (connecting) return;
    localStorage.setItem("vibedeck.mistral-welcome", "done");
    welcomeRef.current?.close();
    setWelcome(false);
  };
  const connectMistral = async () => {
    setConnecting(true);
    setSignInError(null);
    try {
      const connected = await window.vibedeck?.usage?.connect();
      if (connected) {
        localStorage.setItem("vibedeck.mistral-welcome", "done");
        welcomeRef.current?.close();
        setWelcome(false);
        navigate("/usage");
      }
    } catch (error) { setSignInError(String(error)); }
    finally { setConnecting(false); }
  };

  React.useEffect(() => {
    localStorage.setItem("vibedeck.lane", lane);
  }, [lane]);

  // Settings can change the default lane — apply it live.
  React.useEffect(() => {
    const onLane = (e: Event) => {
      const l = (e as CustomEvent).detail;
      if (l === "work" || l === "code") setLane(l);
    };
    window.addEventListener("vibedeck:lane", onLane as EventListener);
    return () => window.removeEventListener("vibedeck:lane", onLane as EventListener);
  }, []);

  const iconBtn =
    "h-8 w-8 grid place-items-center rounded-md text-text-faint hover:text-text hover:bg-surface-muted transition-colors";

  const switchLane = (l: Lane) => { setLane(l); navigate("/"); };

  return (
    <div className="h-full flex flex-col">
      <TitleBar />
      <div className="flex-1 min-h-0 flex">
        {!inWorkspace && <Sidebar
          lane={lane}
          setLane={switchLane}
          sessions={sessions}
          create={create}
          remove={remove}
          health={health}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
        />}
        {!inWorkspace && collapsed && <div className="w-12 shrink-0 border-r border-sidebar-border bg-sidebar p-2 pt-3">
            <button
              onClick={() => setCollapsed(false)}
              title="Show sidebar"
              aria-label="Show sidebar"
              className={iconBtn}
            >
              <PanelLeft size={15} />
            </button>
        </div>}
        <main className="flex-1 min-w-0 h-full overflow-hidden bg-bg relative">
          {!collapsed && location.pathname === "/" && (
            <button
              onClick={() => navigate("/settings")}
              title="Settings"
              aria-label="Settings"
              className={`absolute top-3 right-3 z-10 ${iconBtn}`}
            >
              <Settings size={15} />
            </button>
          )}
          <React.Suspense fallback={<div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-text-muted"><Spinner />Loading...</div>}>
            <Outlet context={{ lane, sessions, health, config, loading, error }} />
          </React.Suspense>
        </main>
      </div>
      {!inWorkspace && <CommandPalette
        lane={lane}
        setLane={switchLane}
        sessions={sessions}
        create={create}
        onToggleSidebar={() => setCollapsed((c) => !c)}
      />}
      {welcome && <dialog ref={welcomeRef} aria-labelledby="mistral-welcome-title" onCancel={event => { event.preventDefault(); dismissWelcome(); }} className="w-[calc(100%_-_2rem)] max-w-md rounded-xl border border-border bg-surface-raised p-6 text-text shadow-2xl backdrop:bg-black/60">
        <h2 id="mistral-welcome-title" className="text-lg font-semibold">Welcome to VibeDeck</h2>
        <p className="mt-3 text-sm text-text-muted">Connect your Mistral account with Google or email for your desktop workspace and subscription usage. Sign-in opens in regular Chrome; your workspace then runs inside VibeDeck.</p>
        <p className="mt-3 text-xs text-text-faint">Your CLI account is shared with Vibe. If it needs setup, run <code>vibe --setup</code> in your terminal. Studio uses a separate Mistral API key.</p>
        {signInError && <p role="alert" className="mt-3 text-sm text-danger">{signInError}</p>}
        {connecting && <div className="mt-5"><SignInConfirmation /></div>}
        {!connecting && <div className="mt-5 flex flex-wrap gap-2">
          <Button autoFocus disabled={connecting} onClick={() => void connectMistral()}>{connecting ? "Waiting for sign-in…" : "Sign in to Mistral"}</Button>
          <Button variant="ghost" disabled={connecting} onClick={dismissWelcome}>Set up later</Button>
        </div>}
      </dialog>}
    </div>
  );
}
