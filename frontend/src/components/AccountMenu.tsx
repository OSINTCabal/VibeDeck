import * as React from "react";
import { SignInConfirmation } from "./SignInConfirmation";
import { Link } from "react-router-dom";
import { ChevronUp, LogIn, UserRound, BarChart3, KeyRound, Settings, FlaskConical, Puzzle, Boxes, Globe } from "lucide-react";
import { Button } from "./ui";
import "@/lib/windowControls";

export function AccountMenu({ user }: { user: string }) {
  const root = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  React.useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const [account, setAccount] = React.useState<{ remembered: boolean } | null>(null);
  const [signingIn, setSigningIn] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const desktop = window.vibedeck?.usage;
  const read = async () => { setAccount(desktop ? await desktop.account() : null); };
  React.useEffect(() => {
    if (!desktop) return;
    let closed = false;
    const refresh = () => { void desktop.account().then(value => { if (!closed) setAccount(value); }).catch(() => {}); };
    refresh();
    window.addEventListener("vibedeck:account-changed", refresh);
    window.addEventListener("vibedeck:usage-refresh", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      closed = true;
      window.removeEventListener("vibedeck:account-changed", refresh);
      window.removeEventListener("vibedeck:usage-refresh", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [desktop]);

  const open = async () => {
    setMenuOpen(false);
    dialog.current?.showModal();
    setError(""); setBusy(true);
    try { await read(); } catch { setError("Could not check your Mistral connection. Try opening your account again."); }
    finally { setBusy(false); }
  };
  const changeAccount = async (signOut: boolean) => {
    if (!desktop || busy) return;
    setBusy(true); setError("");
    try {
      if (signOut) {
        await desktop.disconnect();
        setAccount({ remembered: false });
      } else {
        setSigningIn(true);
        if (!await desktop.connect()) return;
        dialog.current?.close();
      }
    } catch { setError(signOut ? "Sign-out failed. Your connection may still be active. Try again." : "Sign-in could not finish. Please try again."); }
    finally {
      try { await read(); } catch { /* Keep the error and last known account state. */ }
      window.dispatchEvent(new Event("vibedeck:account-changed"));
      setBusy(false); setSigningIn(false);
    }
  };
  const connected = account?.remembered === true;
  return <div ref={root} className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenuOpen(false); }}>
    <button type="button" aria-label="Account" ref={trigger} aria-haspopup="true" aria-expanded={menuOpen} aria-controls="account-popup" onClick={() => setMenuOpen(value => !value)} className="w-full flex h-12 items-center gap-3 px-3 rounded-lg text-left transition-colors duration-75 ease-out hover:bg-surface-muted active:bg-surface-muted/70">
      <span className="h-8 w-8 rounded-full bg-surface-muted text-text-muted grid place-items-center text-xs font-medium shrink-0">{connected ? user.slice(0, 2).toLowerCase() : account ? <LogIn size={14} /> : <UserRound size={14} />}</span>
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-text truncate leading-tight">{connected ? user : account ? "Sign in" : "Mistral account"}</span><span className="block text-[11px] text-primary truncate leading-tight">{connected ? "Browser sign-in saved" : "Mistral account"}</span></span>
      <ChevronUp size={16} className="text-text-faint" />
    </button>
    {menuOpen && <nav id="account-popup" aria-label="Account menu" data-side="top" className="vd-menu absolute bottom-full left-0 z-50 mb-2 w-full max-h-[calc(100vh-8rem)] overflow-y-auto rounded-xl border border-border bg-surface-raised p-1 text-sm shadow-lg">
      <div className="px-3 py-2 text-xs text-text-muted truncate">{connected ? user : "Not signed in"}</div>
      <button autoFocus className="w-full flex min-h-9 items-center gap-2 rounded-sm px-3 py-2 text-left hover:bg-surface-muted transition-colors" onClick={() => void open()}><UserRound size={16} />Mistral account</button>
      {[{to:"/usage",label:"Usage",icon:BarChart3},{to:"/settings?section=providers",label:"API keys",icon:KeyRound},{to:"/settings",label:"Settings",icon:Settings},{to:"/studio",label:"API playground",icon:FlaskConical},{to:"/skills",label:"Skills",icon:Puzzle},{to:"/mcp",label:"MCP",icon:Boxes},{to:"/workspace/work",label:"Mistral workspace",icon:Globe}].map(({to,label,icon:Icon}) => <Link key={to} className="flex min-h-9 items-center gap-2 rounded-sm px-3 py-2 hover:bg-surface-muted transition-colors" to={to} onClick={() => setMenuOpen(false)}><Icon size={16} />{label}</Link>)}
    </nav>}
    <dialog ref={dialog} onClose={() => trigger.current?.focus()} aria-labelledby="account-title" onCancel={event => { if (busy) event.preventDefault(); }} className="w-[calc(100%_-_2rem)] max-w-md rounded-xl border border-border bg-surface-raised p-6 text-text shadow-lg backdrop:bg-black/70">
      <h2 id="account-title" className="text-lg font-semibold">Mistral account</h2>
      <p role="status" className="mt-3 text-sm text-text-muted">{busy ? "Checking your connection..." : connected ? "Browser sign-in saved" : "Not signed in to Mistral."}</p>
      <p className="mt-3 text-sm text-text-muted">Sign in with Google or email in your regular browser. Signing out clears VibeDeck’s workspace session and usage connection. Your CLI login, API keys, and saved chats stay on this device.</p>
      <p className="mt-3 text-xs text-text-faint">Manage your shared CLI account with <code>vibe --setup</code>.</p>
      <p className="mt-3 text-xs text-text-faint">A saved browser sign-in is reused across launches. Mistral may ask you to authenticate again if it expires or is revoked.</p>
      {!desktop && <p className="mt-3 text-sm text-text-muted">Browser account connection requires the Electron desktop app.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      {signingIn && <div className="mt-5"><SignInConfirmation /></div>}
      <div className="mt-5 flex flex-wrap gap-2">
        {desktop && <Button disabled={busy} onClick={() => void changeAccount(false)}>{connected ? "Switch Mistral account" : "Sign in to Mistral"}</Button>}
        {desktop && connected && <Button variant="outline" disabled={busy} onClick={() => void changeAccount(true)}>Sign out of VibeDeck</Button>}
        <Link to="/settings?section=providers" onClick={() => dialog.current?.close()} className="self-center text-sm text-primary hover:underline">Manage API keys</Link>
        <Button variant="ghost" disabled={busy} onClick={() => dialog.current?.close()}>Close</Button>
      </div>
    </dialog>
  </div>;
}
