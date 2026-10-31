"""What runs alongside a session: subagents, background processes, and shell
commands the user runs with ``!``.

* ``session/subagents/read`` lists every subagent the model spawned, with its
  status, model, usage and cost; ``session/subagents/interrupt`` stops the
  running ones.
* Background processes the agent started are part of the session state;
  ``session/backgroundProcess/output`` pages through their output and
  ``session/backgroundProcess/stop`` ends one.
* ``session/shellCommand`` runs a command in the session's folder and hands
  its output to the model as context. The call only returns once the command
  ends, while its output streams into the history as a ``shell`` entry, so the
  sidecar runs it in the background and returns the operation id at once.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import uuid

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from session_rpc import session_call

router = APIRouter()
log = logging.getLogger("vibedeck.processes")

DEFAULT_SHELL_TIMEOUT = 120.0
_shell_ops: dict[str, asyncio.Task] = {}


class ShellReq(BaseModel):
    command: str = Field(min_length=1, max_length=10_000)
    timeout_seconds: float = Field(DEFAULT_SHELL_TIMEOUT, alias="timeoutSeconds", gt=0, le=600)


class InterruptReq(BaseModel):
    reason: str = Field("Stopped from VibeDeck", min_length=1, max_length=500)


@router.get("/api/sessions/{sid}/subagents")
async def subagents(sid: str) -> dict:
    res = (await session_call(sid, "session/subagents/read", {"timeoutMs": 3000}, timeout=15))[2] or {}
    return {"subagents": res.get("subagents", [])}


@router.post("/api/sessions/{sid}/subagents/interrupt")
async def interrupt_subagents(sid: str, r: InterruptReq) -> dict:
    """Stop every running subagent of the session."""
    res = (await session_call(sid, "session/subagents/interrupt", {"reason": r.reason}))[2] or {}
    return {"results": res.get("results", [])}


@router.get("/api/sessions/{sid}/background")
async def background(sid: str) -> dict:
    # a light read: the processes are part of the state, the history is not needed
    res = (await session_call(sid, "session/read", {"history": None, "turns": None}, timeout=15))[2] or {}
    return {"processes": (res.get("state") or {}).get("backgroundProcesses", [])}


@router.get("/api/sessions/{sid}/background/{process_id}/output")
async def background_output(sid: str, process_id: str, cursor: int = Query(0, ge=0),
                            from_end: bool = Query(True, alias="fromEnd")) -> dict:
    """A page of a process's output, decoded; ``fromEnd`` starts at the tail."""
    res = (await session_call(sid, "session/backgroundProcess/output", {
        "processId": process_id, "fromEnd": from_end, "cursor": cursor, "waitMs": 0, "maxBytes": 64_000}))[2] or {}
    if res.get("availability") != "available":
        return {"available": False}
    try:
        text = base64.b64decode(res.get("outputBase64", ""), validate=True).decode("utf-8", errors="replace")
    except ValueError:
        text = ""
    return {"available": True, "text": text, "nextCursor": res.get("nextCursor", cursor),
            "truncatedBefore": bool(res.get("truncatedBefore")), "isFinal": bool(res.get("isFinal")),
            "hasMore": bool(res.get("hasMore"))}


@router.post("/api/sessions/{sid}/background/{process_id}/stop")
async def stop_background(sid: str, process_id: str) -> dict:
    return (await session_call(sid, "session/backgroundProcess/stop", {"processId": process_id}))[2] or {}


@router.post("/api/sessions/{sid}/shell")
async def run_shell(sid: str, r: ShellReq) -> dict:
    """Start ``command`` in the session's folder. Errors Vibe raises at once
    (an empty command, a busy session) come back here; the output streams
    into the conversation."""
    op = str(uuid.uuid4())
    call = session_call(sid, "session/shellCommand", {
        "command": r.command, "operationId": op, "timeoutSeconds": r.timeout_seconds},
        timeout=r.timeout_seconds + 30)
    task = asyncio.create_task(call)
    _shell_ops[op] = task
    task.add_done_callback(lambda t: (_shell_ops.pop(op, None), _log_failure(t)))
    done, _pending = await asyncio.wait({task}, timeout=0.5)
    if done:
        task.result()  # raises the HTTPException of an early refusal
    return {"operationId": op}


def _log_failure(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.warning("shell command failed: %s", task.exception())


@router.post("/api/sessions/{sid}/shell/{operation_id}/interrupt")
async def interrupt_shell(sid: str, operation_id: str) -> dict:
    await session_call(sid, "session/shellCommand", {"action": "interrupt", "operationId": operation_id})
    return {"ok": True}

