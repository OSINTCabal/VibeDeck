"""In-memory native RPC peer. Never starts a process or invokes a model."""
import copy
import time
import uuid

from providers import read_models
from vibe_bridge import AGENT_MODES, BridgeError, VibeAppServer


class FakeBridge(VibeAppServer):
    states = {}
    # review/* answers, shared by every bridge: {"state", "baseline", "turnDiff", "hunks"}
    review = {}

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
            self.states[sid] = {"session": {"id": sid, "cwd": self.cwd, "title": "Test", "model": "mistral-large-4",
                "agent": {"name": "accept-edits"}, "reasoningEffort": None, "status": {"type": "idle"}},
                "eventId": 0, "history": [], "turns": [], "activeCallbacks": [], "childSessions": []}
            return {"state": copy.deepcopy(self.states[sid])}
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
            return {"worktrees": []}
        elif method.startswith("vibeCode/"):
            return self._vibe_code(method, params)
        elif method.startswith("review/"):
            return self._review(method, params)
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
