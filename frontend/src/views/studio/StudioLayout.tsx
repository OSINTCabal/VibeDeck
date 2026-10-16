import * as React from "react";
import { NavLink, Outlet } from "react-router-dom";
import { FlaskConical, Play, Boxes, Bot, Activity, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/studio/playground", icon: Play, label: "Playground" },
  { to: "/studio/models", icon: Boxes, label: "Models" },
  { to: "/studio/agents", icon: Bot, label: "Agents" },
  { to: "/studio/observability", icon: Activity, label: "Observability" },
];

export function StudioLayout() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border shrink-0">
        <FlaskConical size={16} className="text-primary" />
        <span className="text-sm font-semibold">API playground</span>
        <span className="text-xs text-text-faint">local API tools</span>
        <a href="https://console.mistral.ai/" target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1.5 text-xs text-text-muted hover:text-text transition-colors">Open Mistral Studio <ExternalLink size={12} /></a>
      </div>
      <div className="flex flex-1 min-h-0">
        <nav aria-label="Studio sections" className="w-36 xl:w-48 shrink-0 border-r border-border px-2 py-3">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                isActive ? "bg-surface-muted text-text" : "text-text-muted hover:text-text hover:bg-surface-muted/60",
              )}
            >
              <n.icon size={15} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex-1 min-w-0 overflow-hidden">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
