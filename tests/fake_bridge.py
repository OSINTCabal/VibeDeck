"""In-memory native RPC peer. Never starts a process or invokes a model."""
import copy
import os
import time
import uuid

from providers import read_models
from vibe_bridge import AGENT_MODES, BridgeError, VibeAppServer


class FakeBridge(VibeAppServer):
    states = {}
    # review/* answers, shared by every bridge: {"state", "baseline", "turnDiff", "hunks"}
    review = {}
    # session/subagents/read answers, shared by every bridge
    subagents = []

    def __init__(self, cwd, **kwargs):
        super().__init__(cwd, server_cmd="fake")
        self.server_version = "test"
        self.calls = []
        self.failures = {}

    async def start(self):
        pass

    @property
    def alive(self):
        return not self._closed

    async def call(self, method, params=None, timeout=60):
        params = params or {}
        self.calls.append((method, params))
        self.last_activity = time.time()
        if method in self.failures:
            raise self.failures[method]
        sid = params.get("sessionId")
        if method == "session/start":
            sid = uuid.uuid4().hex
            cwd = self.cwd
            worktree = (params.get("agentConfig") or {}).get("worktree")
            if worktree:
                if not os.path.isdir(os.path.join(self.cwd, ".git")):
                    raise BridgeError(-32602, "Not a git repository")
                path = os.path.join(self.cwd, ".vibe-worktrees", "brave-otter")
                os.makedirs(path, exist_ok=True)
            self.states[sid] = {"session": {"id": sid, "cwd": cwd, "title": "Test", "model": "mistral-large-4",
                "agent": {"name": "accept-edits"}, "reasoningEffort": None, "status": {"type": "idle"},
                **({"worktree": {"name": "brave-otter", "branch": "vibe/brave-otter", "path": path, "created": True}} if worktree else {})},
                "eventId": 0, "history": [], "turns": [], "activeCallbacks": [], "childSessions": [],
                "backgroundProcesses": [{"processId": "p1", "command": "npm run dev", "status": "running", "exitCode": None, "createdAt": "2026-10-31T10:00:00Z"}]}
            return {"state": copy.deepcopy(self.states[sid])}
        if method == "skills/installed":
            return {"skills": copy.deepcopy(FakeBridge.extensions.get("installed", [{"name": "local-one", "description": "d", "enabled": True}]))}
        if method in ("session/resume", "session/read"):
            if sid not in self.states:
                raise BridgeError("not_found", "session not found")
            return {"state": copy.deepcopy(self.states[sid])}
        if method == "session/list":
            return {"items": [copy.deepcopy(s["session"]) for s in self.states.values()]}
        if method == "config/read":
            return {"config": {"models": [{"name": "mistral-large-4", "alias": "mistral-large-4", "supportsImages": True}, *read_models()]}}
        if method == "agents/list":
            return {"agents": [{"name": n, "agentType": "agent"} for n in AGENT_MODES] + [
                {"name": n, "displayName": n.capitalize(), "agentType": "subagent"} for n in ("codex", "agy")]}
        if method == "config/model/write":
            if params["modelAlias"] not in {"mistral-large-4", *(m["alias"] for m in read_models())}:
                raise BridgeError("invalid_params", f"unknown model {params['modelAlias']}")
            self.states[sid]["session"].update(model=params["modelAlias"], reasoningEffort=params.get("reasoningEffort"))
        elif method == "session/agent/update":
            self.states[sid]["session"]["agent"] = {"name": params["agentName"]}
        elif method == "session/title/update":
            if sid not in self.states:
                raise BridgeError("not_found", "session not found")
            self.states[sid]["session"]["title"] = params["title"]
        elif method == "session/delete":
            self.states.pop(sid, None)
        elif method == "turn/start":
            turn = {"id": uuid.uuid4().hex, "status": "running"}
            self.states[sid]["session"]["status"] = {"type": "running", "activeTurnId": turn["id"]}
            return {"turn": turn, "lastEventId": 1}
        elif method == "turn/interrupt":
            self.states[sid]["session"]["status"] = {"type": "idle"}
        elif method == "workspace/git/worktrees/list":
            if not os.path.isdir(os.path.join(params["cwd"], ".git")):
                return {"worktrees": []}
            return {"repositoryRoot": params["cwd"], "worktrees": [
                {"name": "brave-otter", "branch": "vibe/brave-otter", "cwd": os.path.join(params["cwd"], ".vibe-worktrees", "brave-otter"),
                 "root": os.path.join(params["cwd"], ".vibe-worktrees", "brave-otter"), "repoRoot": params["cwd"],
                 "branchChanges": {"additions": 3, "deletions": 1} if params.get("includeDetails") else None}]}
        elif method == "workspace/git/worktrees/remove":
            dirty = "dirty" in params["cwd"] and not params.get("force")
            return {"outcome": "kept_dirty" if dirty else "removed", "reasons": ["uncommitted changes"] if dirty else []}
        elif method == "workspace/git/worktrees/prune":
            return {"removed": 2}
        elif method == "workspace/git/worktrees/limit/update":
            return {"limit": params["limit"], "failures": []}
        elif method == "session/compact":
            state = self.states[sid]
            state["history"] = [{"id": "summary", "type": "notice", "text": "Conversation compacted"}]
            for q in list(self._subscribers):
                q.put_nowait({"method": "session/compacted", "params": {
                    "eventId": 9, "sessionId": sid, "oldSessionId": sid, "summaryLength": 42, "state": copy.deepcopy(state)}})
            return {"summary": "We fixed the tests.", "state": copy.deepcopy(state), "sessionLog": {}}
        elif method.startswith("vibeCode/"):
            return self._vibe_code(method, params)
        elif method.startswith("review/"):
            return self._review(method, params)
        elif method.startswith("session/turn/"):
            return self._queue(method, params)
        elif method.startswith(("mcp/", "connectors/", "skills/", "loops/")) and method not in ("skills/list", "skills/installed"):
            return self._extensions(method, params)
        elif method == "session/subagents/read":
            return {"subagents": copy.deepcopy(FakeBridge.subagents)}
        elif method == "session/subagents/interrupt":
            running = [a for a in FakeBridge.subagents if a["status"] == "running"]
            for a in running:
                a["status"] = "interrupted"
            return {"results": [{"sessionId": a["sessionId"], "name": a["name"], "outcome": "interrupted"} for a in running]}
        elif method == "session/backgroundProcess/output":
            text = b"line 1\nline 2\n"
            if params["processId"] != "p1":
                return {"availability": "unavailable", "processId": params["processId"]}
            import base64
            return {"availability": "available", "processId": "p1", "outputBase64": base64.b64encode(text).decode(),
                    "outputStartCursor": 0, "nextCursor": len(text), "bytesAvailable": len(text),
                    "hasMore": False, "truncatedBefore": False, "isFinal": False}
        elif method == "session/backgroundProcess/stop":
            return {"processId": params["processId"], "status": "stopped", "exitCode": None}
        elif method == "session/shellCommand":
            if params.get("action") == "interrupt":
                return {"accepted": True, "lastEventId": 1}
            if params["command"].startswith("fail"):
                raise BridgeError(-32602, "Shell command cannot run now")
            self.shell = [*getattr(self, "shell", []), params]
            return {"accepted": True, "lastEventId": 1}
        elif method == "session/fork":
            source = self.states[params["sourceSessionId"]]
            fork_id = uuid.uuid4().hex
            state = copy.deepcopy(source)
            state["session"].update(id=fork_id, status={"type": "idle"})
            if params.get("entryId"):
                index = next(i for i, e in enumerate(state["history"]) if e["id"] == params["entryId"])
                state["history"] = state["history"][:index + 1]
            self.states[fork_id] = state
            self.forks = [*getattr(self, "forks", []), params]
            return {"sourceSessionId": params["sourceSessionId"], "state": copy.deepcopy(state)}
        elif method == "session/rewind/read":
            return {"hasFileChanges": True, "paths": [f"{self.cwd}/a.py"]}
        elif method == "session/rewind":
            history = self.states[sid]["history"]
            index = next((i for i, e in enumerate(history) if e["id"] == params["entryId"]), None)
            if index is None or history[index].get("role") != "user":
                raise BridgeError(-32004, f"Rewindable history entry not found: {params['entryId']}")
            message = history[index]["content"][0]["text"]
            del history[index:]
            return {"message": message, "restoreErrors": [],
                    "restoredPaths": [f"{self.cwd}/a.py"] if params.get("restoreFiles") else [],
                    "state": copy.deepcopy(self.states[sid]), "sessionLog": {}}
        return {}

    # MCP sources, the skill registry and loops, shared by every bridge
    extensions = {}

    def _extensions(self, method, params):
        ext = FakeBridge.extensions
        sources = ext.setdefault("sources", [
            {"name": "github", "displayName": "github", "kind": "server", "transport": "stdio", "status": "connected", "tools": [{"name": "search"}]},
            {"name": "notion", "displayName": "Notion", "kind": "connector", "transport": "connector", "status": "needs_auth", "tools": []}])
        skills = ext.setdefault("installed", [{"name": "local-one", "description": "d", "enabled": True}])
        loops = ext.setdefault("loops", [])
        if method == "mcp/read":
            return {"mcp": {"sources": copy.deepcopy(sources)}}
        if method == "mcp/toggle":
            src = next(s for s in sources if s["name"] == params["name"])
            src["status"] = "disabled" if params["disabled"] else "connected"
            return {}
        if method == "mcp/add":
            name = params.get("name") or "added"
            sources.append({"name": name, "displayName": name, "kind": "server", "transport": params["transport"], "status": "connecting", "tools": []})
            ext["added"] = params
            return {"name": name, "created": True}
        if method == "mcp/remove":
            ext["sources"] = [s for s in sources if s["name"] != params["name"]]
            return {"name": params["name"], "removed": True}
        if method == "mcp/login":
            for q in list(self._subscribers):
                q.put_nowait({"method": "mcp/authUrl", "params": {"name": params["name"], "url": "https://auth.example/" + params["name"]}})
            return {}
        if method == "mcp/logout":
            return {}
        if method == "connectors/auth/read":
            return {"url": "https://mistral.example/connect/" + params["name"]}
        if method == "skills/catalog":
            return {"skills": [{"name": "reviewer", "skillId": "sk1", "description": "Reviews", "latestVersion": 2}],
                    "updates": {"reviewer": 2} if any(s["name"] == "reviewer" for s in skills) else {}, "authenticated": True}
        if method == "skills/import":
            skills.append({"name": "reviewer", "description": "Reviews", "enabled": True, "skillId": params["skillId"], "version": 1})
            return {}
        if method in ("skills/setEnabled", "skills/setLatest", "skills/remove"):
            ext.setdefault("skill_calls", []).append((method, params))
            if method == "skills/remove":
                ext["installed"] = [s for s in skills if s["name"] != params["name"]]
            return {}
        if method == "loops/list":
            return {"loops": copy.deepcopy(loops)}
        if method == "loops/create":
            loops.append({"id": f"l{len(loops) + 1}", "prompt": params["prompt"], "intervalSeconds": 600, "nextFireAt": 1.0})
            return {"loop": loops[-1]}
        if method == "loops/delete":
            ext["loops"] = [lp for lp in loops if lp["id"] != params["loopId"]]
            return {"loop": {}}
        raise BridgeError("method_not_found", f"Method not found: {method}")

    def _queue(self, method, params):
        """A turn queue: enqueue starts at once when idle, otherwise waits."""
        state = self.states[params["sessionId"]]
        queue = state.setdefault("turnQueue", {"items": [], "paused": False, "maxItems": 32})
        result = {}
        if method == "session/turn/enqueue":
            item = {"id": f"q{len(queue['items']) + 1}-{uuid.uuid4().hex[:6]}", "createdAt": 1, "entries": params["entries"]}
            if state["session"]["status"]["type"] == "idle" and not queue["items"]:
                state["session"]["status"] = {"type": "running", "activeTurnId": "turn-q"}
                return {"queueItemId": item["id"]}
            queue["items"].append(item)
            result = {"queueItemId": item["id"], "waits": True}
        elif method == "session/turn/queue/replace":
            item = next(i for i in queue["items"] if i["id"] == params["queueItemId"])
            item["entries"] = params["entries"]
        elif method == "session/turn/queue/remove":
            queue["items"] = [i for i in queue["items"] if i["id"] != params["queueItemId"]]
        elif method == "session/turn/queue/steer":
            if state["session"]["status"].get("activeTurnId") != params["expectedTurnId"]:
                raise BridgeError(-32010, "The running turn changed")
            queue["items"] = [i for i in queue["items"] if i["id"] != params["queueItemId"]]
            result = {"queueItemId": params["queueItemId"], "turnId": params["expectedTurnId"]}
        elif method == "session/turn/queue/resume":
            queue["paused"] = False
        elif method == "session/turn/queue/read":
            return {"queue": copy.deepcopy(queue)}
        for q in list(self._subscribers):
            q.put_nowait({"method": "turn/queueUpdated", "params": {"sessionId": params["sessionId"], "queue": copy.deepcopy(queue)}})
        return result

    def _review(self, method, params):
        review = FakeBridge.review
        if method == "review/state":
            return copy.deepcopy(review.get("state", {"files": [], "scopes": []}))
        if method == "review/baseline":
            return {"content": review.get("baseline", "")}
        if method == "review/turnDiff":
            return copy.deepcopy(review["turnDiff"])
        if method == "review/hunks":
            return {"hunks": copy.deepcopy(review.get("hunks", []))}
        if method in ("review/approve", "review/revert"):
            review.setdefault("decisions", []).append((method, params["target"]))
            review["state"] = {"files": [], "scopes": []}
            return {}
        raise BridgeError(-32601, f"Method not found: {method}")

    # ---- Vibe Code Web: a picker with one linked project; teleport events are
    # pushed to subscribers like real notifications.
    PROJECT = {"projectId": "p1", "name": "repo", "repositories": [{"repoUrl": "https://github.com/me/repo", "defaultBranch": "main"}], "isReadOnly": False}

    def _view(self, projects):
        return {"context": {"repoRoot": self.cwd, "repoUrl": "https://github.com/me/repo", "repoName": "me/repo", "savedLink": None},
                "state": {"projects": projects, "nextCursor": None, "repoUrl": "https://github.com/me/repo"},
                "git": {"remoteName": "origin", "remoteUrl": "git@github.com:me/repo.git", "repo": "me/repo", "branch": "main", "defaultBranch": "main"}}

    def _emit(self, operation_id, kind, **extra):
        for q in list(self._subscribers):
            q.put_nowait({"method": "vibeCode/teleport/event", "params": {"event": {"kind": kind, "operationId": operation_id, **extra}}})

    def _vibe_code(self, method, params):
        if method == "vibeCode/projects/open":
            return {"pickerId": "picker-1", "view": self._view([self.PROJECT]), "resolvedProjectId": None}
        if method == "vibeCode/projects/select":
            if params["projectId"] not in ("p1", "p2"):
                raise BridgeError("invalid_params", f"Unknown Vibe Code project: {params['projectId']}")
            return {"view": self._view([self.PROJECT]), "project": {**self.PROJECT, "projectId": params["projectId"]}}
        if method == "vibeCode/projects/create":
            project = {**self.PROJECT, "projectId": "p2", "name": params["name"]}
            return {"view": self._view([self.PROJECT, project]), "project": project}
        if method == "vibeCode/projects/cancel":
            return {}
        if method == "vibeCode/teleport/start":
            self.teleport_op = params["operationId"]
            self._emit(self.teleport_op, "summarizing_context")
            self._emit(self.teleport_op, "checking_git")
            self._emit(self.teleport_op, "push_required", unpushedCount=2, branchNotPushed=False)
            return {"operationId": self.teleport_op}
        if method == "vibeCode/teleport/push/respond":
            if params["approved"]:
                self._emit(params["operationId"], "pushing")
                self._emit(params["operationId"], "starting_workflow")
                self._emit(params["operationId"], "complete", url="https://chat.mistral.ai/code/s/123")
            else:
                self._emit(params["operationId"], "failed", error={"code": "push_declined", "message": "Push was declined."})
            return {}
        if method == "vibeCode/teleport/cancel":
            return {"cancelled": True}
        return {}
