import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Conversation } from "@/components/Conversation";
import { getSession } from "@/lib/api";
import { Spinner } from "@/components/ui";
import type { Session } from "@/lib/types";

export function SessionView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let closed = false;
    setSession(null);
    setError(null);
    getSession(id)
      .then(s => { if (!closed) setSession(s); })
      .catch(e => { if (!closed) setError(String(e)); });
    // keep the header (title/model/agent) fresh — renames and picker changes
    const t = setInterval(() => {
      if (!document.hidden) getSession(id).then(s => { if (!closed) setSession(s); }).catch(() => {});
    }, 10000);
    return () => { closed = true; clearInterval(t); };
  }, [id]);

  if (error) {
    return (
      <div className="h-full grid place-items-center">
        <div className="text-center">
          <div className="text-danger text-sm mb-3">{error}</div>
          <button onClick={() => navigate("/")} className="text-primary text-sm underline">
            Back to home
          </button>
        </div>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted text-sm gap-2">
        <Spinner /> Loading session…
      </div>
    );
  }
  return <Conversation key={session.id} session={session} />;
}
