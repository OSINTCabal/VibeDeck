"""Queue follow-up messages while the agent works.

Vibe keeps a per-session turn queue (``session/turn/queue/*``): a queued
message starts as soon as the running turn ends, can be edited or removed
while it waits, or be steered into the running turn right away. When the
session is idle, enqueueing starts the turn at once. Queue changes arrive as
``turn/queueUpdated`` notifications on the session's event stream.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from session_rpc import session_call
from turn_input import user_entry, validate_images

router = APIRouter()


class QueueReq(BaseModel):
    text: str
    images: list[dict] = []
    request_id: str = Field(default_factory=lambda: uuid.uuid4().hex, alias="requestId", max_length=128)


class LoopReq(BaseModel):
    interval: str = Field(pattern=r"^\d+[smhd]$", max_length=8)
    prompt: str = Field(min_length=1, max_length=4000)


class SteerReq(BaseModel):
    expected_turn_id: str = Field(alias="expectedTurnId", min_length=1)


def _entry(r: QueueReq) -> dict:
    if not r.text.strip() and not r.images:
        raise HTTPException(400, "message is empty")
    try:
        validate_images(r.images)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    # the request id doubles as the message id, so a queued message can be rewound
    return user_entry(r.text, r.images, r.request_id)


@router.get("/api/sessions/{sid}/queue")
async def read_queue(sid: str) -> dict:
    return ((await session_call(sid, "session/turn/queue/read"))[2] or {}).get("queue", {})


@router.post("/api/sessions/{sid}/queue")
async def enqueue(sid: str, r: QueueReq) -> dict:
    """Queue a message; it starts at once when nothing is running or waiting."""
    res = (await session_call(sid, "session/turn/enqueue", {
        "entries": [_entry(r)], "idempotencyKey": r.request_id}))[2] or {}
    return {"queueItemId": res.get("queueItemId"), "waits": bool(res.get("waits"))}


@router.put("/api/sessions/{sid}/queue/{item_id}")
async def replace(sid: str, item_id: str, r: QueueReq) -> dict:
    """Rewrite a waiting message."""
    await session_call(sid, "session/turn/queue/replace", {
        "queueItemId": item_id, "entries": [_entry(r)], "idempotencyKey": r.request_id})
    return await read_queue(sid)


@router.delete("/api/sessions/{sid}/queue/{item_id}")
async def remove(sid: str, item_id: str) -> dict:
    await session_call(sid, "session/turn/queue/remove", {"queueItemId": item_id})
    return await read_queue(sid)


@router.post("/api/sessions/{sid}/queue/{item_id}/steer")
async def steer(sid: str, item_id: str, r: SteerReq) -> dict:
    """Hand a waiting message to the running turn now instead of after it."""
    res = (await session_call(sid, "session/turn/queue/steer", {
        "queueItemId": item_id, "expectedTurnId": r.expected_turn_id}))[2] or {}
    return {"queueItemId": res.get("queueItemId"), "turnId": res.get("turnId")}


@router.post("/api/sessions/{sid}/queue/resume")
async def resume(sid: str) -> dict:
    """Start the queue again after it paused (an interrupted or failed turn)."""
    await session_call(sid, "session/turn/queue/resume")
    return await read_queue(sid)


def queue_event(params: dict) -> Optional[dict]:
    """SSE event for a ``turn/queueUpdated`` notification."""
    queue = params.get("queue")
    return {"kind": "queue", "queue": queue} if isinstance(queue, dict) else None


# ---- loops: a prompt Vibe sends again on an interval while the session is open

@router.get("/api/sessions/{sid}/loops")
async def list_loops(sid: str) -> dict:
    return {"loops": ((await session_call(sid, "loops/list"))[2] or {}).get("loops", [])}


@router.post("/api/sessions/{sid}/loops")
async def create_loop(sid: str, r: LoopReq) -> dict:
    """``interval`` like ``10m``; the first run is one interval from now."""
    await session_call(sid, "loops/create", {"interval": r.interval, "prompt": r.prompt})
    return await list_loops(sid)


@router.delete("/api/sessions/{sid}/loops/{loop_id}")
async def delete_loop(sid: str, loop_id: str) -> dict:
    await session_call(sid, "loops/delete", {"loopId": loop_id})
    return await list_loops(sid)
