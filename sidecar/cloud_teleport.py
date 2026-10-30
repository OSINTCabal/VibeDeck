"""Vibe Code Web ("cloud") sessions for VibeDeck.

The vibe app-server owns the whole flow: a project picker bound to the
session's git repository (``vibeCode/projects/*``) and a teleport that
summarizes the conversation, pushes the branch with the user's approval and
starts the session on Vibe Code Web (``vibeCode/teleport/*``). Teleport
progress arrives as ``vibeCode/teleport/event`` notifications; this module
collects them per operation so the UI can poll a single endpoint.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

EVENT_METHOD = "vibeCode/teleport/event"
TERMINAL = {"complete", "failed"}
OPERATION_TTL = 30 * 60
WATCH_TIMEOUT = 15 * 60


@dataclass
class TeleportOperation:
    id: str
    sid: str
    started: float = field(default_factory=time.time)
    events: list[dict] = field(default_factory=list)
    status: str = "starting"
    url: Optional[str] = None
    error: Optional[str] = None
    push: Optional[dict] = None

    def apply(self, event: dict) -> None:
        kind = event.get("kind")
        if not isinstance(kind, str):
            return
        self.events.append({"kind": kind, "at": time.time()})
        self.status = kind
        if kind == "push_required":
            self.push = {"unpushedCount": event.get("unpushedCount") or 0,
                         "branchNotPushed": bool(event.get("branchNotPushed"))}
        elif kind == "pushing":
            self.push = None
        elif kind == "complete":
            self.url = event.get("url") if isinstance(event.get("url"), str) else None
        elif kind == "failed":
            error = event.get("error") or {}
            self.error = (error.get("message") if isinstance(error, dict) else None) or "Teleport failed."

    @property
    def done(self) -> bool:
        return self.status in TERMINAL or self.status == "cancelled"

    def view(self) -> dict:
        return {"operationId": self.id, "status": self.status, "url": self.url, "error": self.error,
                "push": self.push, "events": self.events, "done": self.done}


class TeleportRegistry:
    def __init__(self) -> None:
        self._ops: dict[str, TeleportOperation] = {}
        self._watchers: dict[str, asyncio.Task] = {}

    def get(self, sid: str, op_id: str) -> Optional[TeleportOperation]:
        op = self._ops.get(op_id)
        return op if op is not None and op.sid == sid else None

    def _prune(self) -> None:
        cutoff = time.time() - OPERATION_TTL
        for op_id, op in list(self._ops.items()):
            if op.started < cutoff and op_id not in self._watchers:
                del self._ops[op_id]

    async def start(self, bridge: Any, sid: str, esid: str, picker_id: str,
                    project_id: str, prompt: Optional[str]) -> TeleportOperation:
        """Subscribe before starting so no early event is missed."""
        self._prune()
        op = TeleportOperation(id=str(uuid.uuid4()), sid=sid)
        # a UI-style subscription keeps the idle reaper off the bridge while
        # the teleport waits on push approval or the remote workflow
        queue = bridge.subscribe()
        try:
            params: dict[str, Any] = {"sessionId": esid, "pickerId": picker_id,
                                      "operationId": op.id, "projectId": project_id}
            if prompt:
                params["prompt"] = prompt
            await bridge.call("vibeCode/teleport/start", params, timeout=60)
        except BaseException:
            bridge.unsubscribe(queue)
            raise
        self._ops[op.id] = op
        task = asyncio.create_task(self._watch(bridge, queue, op))
        self._watchers[op.id] = task
        task.add_done_callback(lambda _t: self._watchers.pop(op.id, None))
        return op

    async def _watch(self, bridge: Any, queue: asyncio.Queue, op: TeleportOperation) -> None:
        deadline = time.monotonic() + WATCH_TIMEOUT
        try:
            while not op.done:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    op.status, op.error = "failed", "Teleport timed out."
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=min(remaining, 30))
                except asyncio.TimeoutError:
                    continue
                if msg is None:
                    if not op.done:
                        op.status, op.error = "failed", "The Vibe session closed during teleport."
                    break
                if msg.get("method") != EVENT_METHOD:
                    continue
                event = (msg.get("params") or {}).get("event") or {}
                if event.get("operationId") == op.id:
                    op.apply(event)
        finally:
            bridge.unsubscribe(queue)

    async def cancel(self, bridge: Any, esid: str, op: TeleportOperation) -> bool:
        if op.done:
            return False
        result = await bridge.call("vibeCode/teleport/cancel", {"sessionId": esid, "operationId": op.id})
        cancelled = bool((result or {}).get("cancelled"))
        if cancelled:
            op.status = "cancelled"
            op.push = None
        return cancelled
