import * as React from "react";
import { Button } from "./ui";
import "@/lib/windowControls";

export function SignInConfirmation({ connectors = false }: { connectors?: boolean }) {
  const [finishing, setFinishing] = React.useState(false);
  const [error, setError] = React.useState("");
  const finish = async (accepted: boolean) => {
    setFinishing(true); setError("");
    try {
      if (!await window.vibedeck?.usage?.confirmSignIn(accepted)) {
        setError("The sign-in browser is still opening. Try again in a moment.");
        setFinishing(false);
      }
    } catch { setError("Could not finish sign-in. Try again."); setFinishing(false); }
  };
  return <div className="w-full space-y-3" role="group" aria-label="Finish Mistral sign-in">
    <p role="status" className="text-sm text-text-muted">{finishing ? "Connecting your Mistral session..." : connectors ? "Add and authorize your services in Chrome, then return here." : "Finish signing in with Google or email in Chrome, then return here."}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={finishing} onClick={() => void finish(true)}>{connectors ? "I’ve finished setup" : "I’ve signed in"}</Button>
      <Button variant="ghost" disabled={finishing} onClick={() => void finish(false)}>Cancel sign-in</Button>
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
