import * as React from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { transcribe } from "@/lib/api";

const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

/**
 * Dictation: records from the microphone until clicked again, then has the
 * sidecar transcribe the clip with Voxtral and hands the text over.
 */
export function DictationButton({ onText, onError, disabled }: {
  onText: (text: string) => void; onError: (message: string) => void; disabled?: boolean;
}) {
  const [phase, setPhase] = React.useState<"idle" | "recording" | "transcribing">("idle");
  const recorder = React.useRef<MediaRecorder | null>(null);
  const chunks = React.useRef<Blob[]>([]);

  React.useEffect(() => () => {
    const r = recorder.current;
    if (r && r.state !== "inactive") { r.onstop = null; r.stop(); }
    r?.stream.getTracks().forEach(t => t.stop());
  }, []);

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("This window cannot record audio.");
      return;
    }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { onError("Microphone access was refused."); return; }
    const mimeType = TYPES.find(t => MediaRecorder.isTypeSupported(t));
    const r = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks.current = [];
    r.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunks.current, { type: (r.mimeType || "audio/webm").split(";")[0] });
      if (!blob.size) { setPhase("idle"); return; }
      setPhase("transcribing");
      try {
        const { text } = await transcribe(blob);
        if (text) onText(text); else onError("No speech was recognised.");
      } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
      finally { setPhase("idle"); }
    };
    recorder.current = r;
    r.start();
    setPhase("recording");
  };
  const stop = () => recorder.current?.state === "recording" && recorder.current.stop();

  const label = phase === "recording" ? "Stop dictation" : phase === "transcribing" ? "Transcribing…" : "Dictate";
  return (
    <button type="button" onClick={() => (phase === "recording" ? stop() : phase === "idle" ? void start() : undefined)}
      disabled={disabled || phase === "transcribing"} title={label} aria-label={label} aria-pressed={phase === "recording"}
      className={cn("h-8 w-8 shrink-0 grid place-items-center rounded-md transition-colors disabled:opacity-40",
        phase === "recording" ? "bg-danger/15 text-danger" : "text-text-muted hover:bg-surface-muted hover:text-text")}>
      {phase === "transcribing" ? <Loader2 size={15} className="animate-spin" />
        : phase === "recording" ? <Square size={11} fill="currentColor" className="animate-pulse" /> : <Mic size={15} />}
    </button>
  );
}
