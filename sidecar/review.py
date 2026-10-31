"""Review the agent's file changes, and rewind a conversation.

Vibe checkpoints every file a turn touches. ``review/*`` reports the pending
changes per file and per turn ("scope") and keeps or reverts them hunk by
hunk; ``session/rewind`` drops a user message and everything after it,
optionally restoring the files to how they stood before it.

The diff is rendered here, not in the UI, with the same ``SequenceMatcher``
Vibe uses for its regions, so the hunk anchors from ``review/hunks`` (a side
and a 0-based line) land on the rows they belong to.
"""
from __future__ import annotations

import os
from difflib import SequenceMatcher
from pathlib import Path
from typing import Annotated, Literal, Optional, Union

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from session_rpc import session_call

router = APIRouter()

CONTEXT_LINES = 3
MAX_DIFF_LINES = 20000
MAX_FILE_BYTES = 4 * 1024 * 1024


# ---- targets, as the app-server takes them (camelCase on the wire)

class _Wire(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class AgentOwner(_Wire):
    kind: Literal["agent"]
    turn_id: int = Field(alias="turnId")


class ManualOwner(_Wire):
    kind: Literal["manual"]
    index: int


Owner = Annotated[Union[AgentOwner, ManualOwner], Field(discriminator="kind")]


class RegionRef(_Wire):
    version_index: int = Field(alias="versionIndex", ge=0)
    ordinal: int = Field(ge=0)


class RegionTarget(_Wire):
    kind: Literal["region"]
    path: str
    version_index: int = Field(alias="versionIndex", ge=0)
    ordinal: int = Field(ge=0)


class RegionsTarget(_Wire):
    kind: Literal["regions"]
    path: str
    regions: list[RegionRef] = Field(min_length=1)


class ScopeTarget(_Wire):
    kind: Literal["scope"]
    owner: Owner


class ScopeFileTarget(_Wire):
    kind: Literal["scopeFile"]
    owner: Owner
    path: str


class FileTarget(_Wire):
    kind: Literal["file"]
    path: str


class AllTarget(_Wire):
    kind: Literal["all"]


class LastTurnsTarget(_Wire):
    kind: Literal["lastTurns"]
    count: int = Field(ge=1)


Target = Annotated[
    Union[RegionTarget, RegionsTarget, ScopeTarget, ScopeFileTarget, FileTarget, AllTarget, LastTurnsTarget],
    Field(discriminator="kind"),
]


class DecisionReq(BaseModel):
    target: Target


class RewindReq(BaseModel):
    restore_files: StrictBool = Field(False, alias="restoreFiles")


# ---- diff rendering

def _lines(text: str) -> list[str]:
    return text.splitlines(keepends=True)


def _strip(line: str) -> str:
    return line.rstrip("\r\n")


def diff_rows(baseline: str, current: str, context: int = CONTEXT_LINES) -> list[dict]:
    """Unified diff rows: ``ctx``/``del``/``add`` lines with 0-based ``old``
    and ``new`` numbers, and ``skip`` rows for collapsed unchanged runs."""
    a, b = _lines(baseline), _lines(current)
    rows: list[dict] = []
    ops = SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes()
    for n, (tag, i1, i2, j1, j2) in enumerate(ops):
        if tag != "equal":
            rows.extend({"t": "del", "old": i, "text": _strip(a[i])} for i in range(i1, i2))
            rows.extend({"t": "add", "new": j, "text": _strip(b[j])} for j in range(j1, j2))
            continue
        head = 0 if n == 0 else context
        tail = 0 if n == len(ops) - 1 else context
        length = i2 - i1
        if length <= head + tail + 1:
            keep = range(length)
            skipped = 0
        else:
            keep = [*range(head), *range(length - tail, length)]
            skipped = length - head - tail
        for k in keep:
            if skipped and k == length - tail:
                rows.append({"t": "skip", "count": skipped})
            rows.append({"t": "ctx", "old": i1 + k, "new": j1 + k, "text": _strip(a[i1 + k])})
        if skipped and tail == 0:
            rows.append({"t": "skip", "count": skipped})
    return rows


def anchor_hunks(rows: list[dict], hunks: list[dict]) -> list[dict]:
    """Pin each pending hunk to the first row it starts on."""
    anchored = []
    for hunk in hunks:
        side, line = hunk.get("side"), hunk.get("line")
        key, kind = ("old", "del") if side == "deletions" else ("new", "add")
        row = next((i for i, r in enumerate(rows) if r["t"] == kind and r.get(key) == line), None)
        if row is None:
            row = next((i for i, r in enumerate(rows) if r.get(key) == line), None)
        if row is None:
            # an insertion past the last line, or a hunk the diff collapsed
            row = len(rows) - 1 if rows else 0
        # controls go above the whole change block (its deletions, then additions)
        while row > 0 and rows[row - 1]["t"] in ("del", "add") and not (rows[row]["t"] == "del" and rows[row - 1]["t"] == "add"):
            row -= 1
        anchored.append({**hunk, "row": row})
    return anchored


# ---- helpers

def _owner_param(owner: Optional[str]) -> Optional[dict]:
    """``agent:3`` / ``manual:1`` from a query string."""
    if not owner:
        return None
    kind, _, value = owner.partition(":")
    if kind not in ("agent", "manual") or not value.isdigit():
        raise HTTPException(400, "owner must be agent:<turn> or manual:<index>")
    return {"kind": "agent", "turnId": int(value)} if kind == "agent" else {"kind": "manual", "index": int(value)}


def _read_current(cwd: str, path: str) -> Optional[str]:
    full = Path(path) if os.path.isabs(path) else Path(cwd) / path
    try:
        if full.stat().st_size > MAX_FILE_BYTES:
            raise HTTPException(413, "This file is too large to show here.")
        return full.read_bytes().decode("utf-8", errors="replace")
    except FileNotFoundError:
        return ""
    except OSError as e:
        raise HTTPException(409, f"Cannot read {path}: {e.strerror}") from e


# ---- routes

@router.get("/api/sessions/{sid}/review")
async def review_state(sid: str) -> dict:
    bridge, _esid, state = await session_call(sid, "review/state")
    return {"cwd": bridge.cwd, **(state or {})}


@router.get("/api/sessions/{sid}/review/file")
async def review_file(sid: str, path: str = Query(..., min_length=1), owner: Optional[str] = None) -> dict:
    """One file's diff with its pending hunks: the whole pending change, or one
    turn's own change when ``owner`` is given."""
    owner_obj = _owner_param(owner)
    bridge, _esid, state = await session_call(sid, "review/state")
    files = {f.get("path"): f for f in (state or {}).get("files", [])}
    if owner_obj is None and path not in files:
        raise HTTPException(404, "This file has no pending changes.")
    if owner_obj is not None:
        scope = next((s for s in (state or {}).get("scopes", []) if s.get("owner") == owner_obj), None)
        if scope is None or not any(f.get("path") == path for f in scope.get("files", [])):
            raise HTTPException(404, "This turn has no pending changes to that file.")
        diff = (await session_call(sid, "review/turnDiff", {"path": path, "owner": owner_obj}))[2] or {}
        status, baseline, current = diff.get("status"), diff.get("baseline", ""), diff.get("current", "")
    else:
        status = files[path].get("status")
        baseline = ((await session_call(sid, "review/baseline", {"path": path}))[2] or {}).get("content", "")
        current = _read_current(bridge.cwd, path)
    hunk_params: dict = {"path": path}
    if owner_obj is not None:
        hunk_params["owner"] = owner_obj
    hunks = ((await session_call(sid, "review/hunks", hunk_params))[2] or {}).get("hunks", [])
    if status == "binary_or_undecodable":
        return {"path": path, "status": status, "rows": [], "hunks": hunks, "opaque": True}
    if len(_lines(baseline)) + len(_lines(current)) > MAX_DIFF_LINES:
        return {"path": path, "status": status, "rows": [], "hunks": hunks, "tooLarge": True}
    rows = diff_rows(baseline, current)
    return {"path": path, "status": status, "rows": rows, "hunks": anchor_hunks(rows, hunks)}


@router.post("/api/sessions/{sid}/review/{action}")
async def review_decide(sid: str, action: Literal["approve", "revert"], r: DecisionReq) -> dict:
    """Keep (approve) or roll back (revert) the targeted changes. Reverting
    writes the reconstructed files to disk; the session must be idle."""
    target = r.target.model_dump(by_alias=True)
    await session_call(sid, f"review/{action}", {"target": target})
    return (await review_state(sid))


@router.get("/api/sessions/{sid}/rewind/{entry_id}")
async def rewind_preview(sid: str, entry_id: str) -> dict:
    """Files a rewind to this user message would restore."""
    return (await session_call(sid, "session/rewind/read", {"entryId": entry_id}))[2] or {}


@router.post("/api/sessions/{sid}/rewind/{entry_id}")
async def rewind(sid: str, entry_id: str, r: RewindReq) -> dict:
    """Drop this user message and everything after it. The message text comes
    back so the UI can put it in the composer."""
    try:
        res = (await session_call(sid, "session/rewind", {
            "entryId": entry_id, "restoreFiles": r.restore_files, "inplace": True}, timeout=120))[2] or {}
    except HTTPException as e:
        if e.status_code == 409 and "Cannot find user entry" in str(e.detail):
            raise HTTPException(409, "This message was sent before VibeDeck recorded message ids, so Vibe "
                                     "cannot rewind to it. Later messages can be rewound.") from e
        raise
    return {"message": res.get("message", ""), "restoredPaths": res.get("restoredPaths", []),
            "restoreErrors": res.get("restoreErrors", [])}
