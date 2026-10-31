"""Git worktrees Vibe manages for sessions, and context compaction.

A session started with a worktree works on its own branch in a checkout
under Vibe's worktrees folder, so several agents can change one repository
without stepping on each other. Listing, removing and pruning those
worktrees is not tied to a session, so it runs on the sidecar's host bridge.

``session/compact`` replaces the conversation so far with a summary to free
the context window.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, StrictBool
from session_rpc import TRANSPORT_ERRORS, session_call
from vibe_bridge import BridgeError

router = APIRouter()

HostBridge = Callable[[], Awaitable[Any]]
SessionCwds = Callable[[], list[str]]
_host: Optional[HostBridge] = None
_session_cwds: Optional[SessionCwds] = None


def configure(host: HostBridge, session_cwds: SessionCwds) -> None:
    """``host`` returns a bridge not bound to any session; ``session_cwds``
    lists the working folders of known sessions (where worktrees are looked for)."""
    global _host, _session_cwds
    _host, _session_cwds = host, session_cwds


async def _host_call(method: str, params: Optional[dict] = None, timeout: float = 60) -> Any:
    if _host is None:
        raise RuntimeError("worktrees.configure() was not called")
    bridge = await _host()
    try:
        return await bridge.call(method, params or {}, timeout=timeout)
    except BridgeError as e:
        raise HTTPException(502 if e.code in TRANSPORT_ERRORS else 409, e.message) from e


class RemoveReq(BaseModel):
    cwd: str = Field(min_length=1)
    force: StrictBool = False


class LimitReq(BaseModel):
    limit: int = Field(ge=0, le=100)


class CompactReq(BaseModel):
    instructions: str = Field("", max_length=4000)


@router.get("/api/worktrees/all")
async def all_worktrees() -> dict:
    """Vibe's worktrees for every repository a session has used, with how far
    each branch has moved."""
    seen: dict[str, dict] = {}
    repos: set[str] = set()
    for cwd in sorted(set((_session_cwds or (lambda: []))())):
        try:
            res = await _host_call("workspace/git/worktrees/list", {"cwd": cwd, "includeDetails": True})
        except HTTPException:
            continue  # not a repository, or gone
        if res.get("repositoryRoot"):
            repos.add(res["repositoryRoot"])
        for wt in res.get("worktrees", []):
            seen.setdefault(wt.get("cwd") or wt.get("root"), wt)
    return {"worktrees": sorted(seen.values(), key=lambda w: (w.get("repoRoot", ""), w.get("name", ""))),
            "repositories": sorted(repos)}


@router.post("/api/worktrees/remove")
async def remove_worktree(r: RemoveReq) -> dict:
    """Remove a worktree. Without ``force`` Vibe keeps one with uncommitted
    changes or new commits and says so (``outcome: kept_dirty``)."""
    return await _host_call("workspace/git/worktrees/remove", {"cwd": r.cwd, "force": r.force}, timeout=120)


@router.post("/api/worktrees/prune")
async def prune_worktrees() -> dict:
    return await _host_call("workspace/git/worktrees/prune", timeout=120)


@router.put("/api/worktrees/limit")
async def worktree_limit(r: LimitReq) -> dict:
    """How many unused worktrees Vibe keeps before pruning the oldest."""
    return await _host_call("workspace/git/worktrees/limit/update", {"limit": r.limit})


@router.post("/api/sessions/{sid}/compact")
async def compact(sid: str, r: CompactReq) -> dict:
    """Summarise the conversation so far to free the context window. The new
    history reaches the UI through the session's event stream."""
    res = (await session_call(sid, "session/compact", {"extraInstructions": r.instructions}, timeout=300))[2] or {}
    return {"summary": res.get("summary", "")}
