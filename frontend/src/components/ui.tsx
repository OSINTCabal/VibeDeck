import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- Menu presence

/**
 * Keeps a popover mounted for its 150ms exit animation after `open` turns
 * false. Render while `mounted`; put `state` on the panel's data-state.
 */
export function usePresence(open: boolean, ms = 150) {
  const [mounted, setMounted] = React.useState(open);
  React.useEffect(() => {
    if (open) { setMounted(true); return; }
    const timer = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(timer);
  }, [open, ms]);
  return { mounted: open || mounted, state: open ? "open" : "closed" } as const;
}

/** Shared popover panel and row styles (the webapp's dropdown menu). */
export const menuPanel = "vd-menu rounded-xl border border-border bg-surface-raised p-1 shadow-lg";
export const menuItem = "flex w-full min-h-9 items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-text transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-none";
export const menuLabel = "px-3 pt-2 pb-1 text-xs font-medium text-text-faint";

// ---------------------------------------------------------------- Radio mark

/** The webapp's 16px radio: orange ring with a punched-out centre when checked. */
export function RadioMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span aria-hidden="true" className={cn(
      "relative inline-flex h-4 w-4 shrink-0 rounded-full border transition-colors",
      checked ? "border-transparent bg-primary" : "border-border bg-bg",
      className,
    )}>
      <span className={cn("absolute inset-0 rounded-full bg-bg transition-transform duration-150", checked && "scale-50")} />
    </span>
  );
}

// ---------------------------------------------------------------- Button

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md" | "lg" | "icon";
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", ...props }, ref) => {
    const variants: Record<string, string> = {
      primary: "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-press",
      secondary: "bg-surface-muted text-text hover:bg-surface-muted/70",
      outline: "border border-border bg-transparent text-text hover:bg-surface-muted",
      ghost: "text-text-muted hover:text-text hover:bg-surface-muted",
      danger: "bg-danger text-white hover:bg-danger/90",
    };
    const sizes: Record<string, string> = {
      sm: "h-8 px-3 text-sm rounded-md",
      md: "h-9 px-4 text-sm rounded-md",
      lg: "h-11 px-5 text-base rounded-lg",
      icon: "h-8 w-8 p-0 rounded-md grid place-items-center",
    };
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-[background-color,border-color,color,scale] duration-75 ease-out active:scale-[0.98]",
          "disabled:opacity-50 disabled:pointer-events-none",
          variants[variant], sizes[size], className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

// ---------------------------------------------------------------- Inputs

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-text transition-colors",
        "placeholder:text-text-faint hover:border-border-strong focus-visible:outline-none focus-visible:border-border-strong",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text resize-none transition-colors",
        "placeholder:text-text-faint hover:border-border-strong focus-visible:outline-none focus-visible:border-border-strong",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

// ---------------------------------------------------------------- Badge

export function Badge({
  children, tone = "default", className,
}: {
  children: React.ReactNode; tone?: "default" | "primary" | "success" | "warning" | "danger" | "info"; className?: string;
}) {
  const tones: Record<string, string> = {
    default: "bg-surface-muted text-text-muted",
    primary: "bg-primary/15 text-primary",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-danger/15 text-danger",
    info: "bg-info/15 text-info",
  };
  return (
    <span className={cn("inline-flex items-center rounded-sm px-1.5 py-0.5 text-xs font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- Card

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-xl border border-border bg-surface", className)}>{children}</div>;
}

export function CardHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-4 py-3 border-b border-border", className)}>{children}</div>;
}

export function CardBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-4 py-3", className)}>{children}</div>;
}

// ---------------------------------------------------------------- Dialog

export function Dialog({
  open, onClose, title, children, className,
}: {
  open: boolean; onClose: () => void; title?: string; children: React.ReactNode; className?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/70 animate-fade-in" onClick={onClose} />
      <div className={cn("vd-menu relative w-full max-w-lg rounded-xl border border-border bg-surface-raised shadow-lg", className)}>
        {title && (
          <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-2">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button onClick={onClose} aria-label="Close" title="Close" className="-mr-1.5 grid h-8 w-8 place-items-center rounded-md text-text-muted transition-colors hover:bg-surface-muted hover:text-text"><X size={16} /></button>
          </div>
        )}
        <div className="px-5 pt-2 pb-5">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Select (native, styled)

export function Select({
  value, onChange, options, className, ...props
}: {
  value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; className?: string;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange">) {
  return (
    <select
      value={value} onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-9 rounded-md border border-border bg-surface px-2 text-sm text-text transition-colors",
        "hover:border-border-strong focus-visible:outline-none focus-visible:border-border-strong",
        className,
      )}
      {...props}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- Spinner

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block h-4 w-4 rounded-full border-2 border-text-faint border-t-primary animate-spin", className)}
      aria-label="loading"
    />
  );
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn("h-px bg-border", className)} />;
}

export function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-surface-raised border border-border px-2 py-1 text-xs text-text opacity-0 shadow-lg group-hover:opacity-100 transition-opacity z-20">
        {label}
      </span>
    </span>
  );
}
