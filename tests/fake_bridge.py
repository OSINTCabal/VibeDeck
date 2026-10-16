"""In-memory native RPC peer. Never starts a process or invokes a model."""
import copy
import time
import uuid

from providers import read_models
from vibe_bridge import AGENT_MODES, BridgeError, VibeAppServer


class FakeBridge(VibeAppServer):
    states = {}

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
        return {}
