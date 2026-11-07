import * as React from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- Button

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md" | "lg" | "icon";
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", ...props }, ref) => {
    const variants: Record<string, string> = {
      primary: "bg-primary text-primary-foreground hover:bg-[#ff8a3d] active:bg-[#e5640a]",
      secondary: "bg-surface-muted text-text hover:bg-surface-raised",
      outline: "border border-border bg-transparent text-text hover:bg-surface-muted",
      ghost: "text-text-muted hover:text-text hover:bg-surface-muted",
      danger: "bg-danger text-white hover:bg-[#c0392b]",
    };
    const sizes: Record<string, string> = {
      sm: "h-8 px-3 text-sm rounded-md",
      md: "h-9 px-4 text-sm rounded-lg",
      lg: "h-11 px-5 text-base rounded-lg",
      icon: "h-9 w-9 p-0 rounded-lg grid place-items-center",
    };
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors",
          "disabled:opacity-50 disabled:pointer-events-none focus-visible:ring-2 focus-visible:ring-primary",
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
        "h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text",
        "placeholder:text-text-faint focus-visible:ring-2 focus-visible:ring-primary focus-visible:border-transparent",
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
        "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text resize-none",
        "placeholder:text-text-faint focus-visible:ring-2 focus-visible:ring-primary focus-visible:border-transparent",
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
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- Card

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-lg border border-border bg-surface", className)}>{children}</div>;
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
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className={cn("relative w-full max-w-lg rounded-xl border border-border bg-surface-raised shadow-2xl animate-slide-up", className)}>
        {title && (
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <h2 className="text-base font-semibold">{title}</h2>
            <button onClick={onClose} className="text-text-muted transition-colors hover:text-text text-sm">Close</button>
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
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
        "h-9 rounded-lg border border-border bg-surface px-2 text-sm text-text",
        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:border-transparent",
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
      <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-surface-raised border border-border px-2 py-1 text-xs text-text opacity-0 group-hover:opacity-100 transition-opacity z-20">
        {label}
      </span>
    </span>
  );
}
