import { lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Welcome } from "@/views/Welcome";
import { StudioLayout } from "@/views/studio/StudioLayout";
import { ModelsView } from "@/views/studio/Models";
import { AgentsView } from "@/views/studio/Agents";
import { ObservabilityView } from "@/views/studio/Observability";
import { SkillsView } from "@/views/SkillsView";
import { McpView } from "@/views/McpView";
import { WorkContextView, type WorkSection } from "@/views/WorkContextView";
import { WorkspaceView } from "@/views/WorkspaceView";
import { ExtensionsView } from "@/views/ExtensionsView";

const CloudSessionView = lazy(() => import("@/views/CloudSessionView").then(module => ({ default: module.CloudSessionView })));
const SessionView = lazy(() => import("@/views/SessionView").then(module => ({ default: module.SessionView })));
const Playground = lazy(() => import("@/views/studio/Playground").then(module => ({ default: module.Playground })));
const UsageView = lazy(() => import("@/views/UsageView").then(module => ({ default: module.UsageView })));
const SettingsView = lazy(() => import("@/views/SettingsView").then(module => ({ default: module.SettingsView })));

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<Welcome />} />
          <Route path="sessions/:id" element={<SessionView />} />
          <Route path="cloud/:projectId/:sessionId" element={<CloudSessionView />} />
          <Route path="studio" element={<StudioLayout />}>
            <Route index element={<Navigate to="/studio/playground" replace />} />
            <Route path="playground" element={<Playground />} />
            <Route path="models" element={<ModelsView />} />
            <Route path="usage" element={<Navigate to="/usage" replace />} />
            <Route path="agents" element={<AgentsView />} />
            <Route path="observability" element={<ObservabilityView />} />
          </Route>
          <Route path="workspace/:section" element={<WorkspaceView />} />
          <Route path="usage" element={<UsageView />} />
          <Route path="skills" element={<SkillsView />} />
          <Route path="mcp" element={<McpView />} />
          {(["knowledge", "libraries", "connectors", "instructions", "scheduled"] as WorkSection[]).map(section =>
            <Route key={section} path={section} element={<WorkContextView key={section} section={section} />} />)}
          <Route path="extensions" element={<ExtensionsView />} />
          <Route path="settings" element={<SettingsView />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
