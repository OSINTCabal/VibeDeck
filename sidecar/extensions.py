"""MCP servers, connectors and the skill catalog, managed from VibeDeck.

``mcp/read`` lists the MCP servers in ``~/.vibe/config.toml`` together with
the Mistral connectors the account can use, each with its status and tools.
Servers and connectors are switched on and off with ``mcp/toggle``; servers
are added with ``mcp/add`` and removed with ``mcp/remove``; OAuth servers sign
in with ``mcp/login``, which answers with an ``mcp/authUrl`` notification, and
connectors with the URL from ``connectors/auth/read``.

``skills/catalog`` lists the skills in the account's Vibe registry; they are
installed with ``skills/import``, kept current with ``skills/setLatest``, and
switched or removed like local skills.

Those calls need a session to read the effective configuration, so this
module keeps one app-server with an ephemeral session that never appears in
any session list. Config changes reach existing sessions through the sidecar's
registry watch, which reloads them when they are next idle.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Callable, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, StrictBool
from session_rpc import TRANSPORT_ERRORS
from vibe_bridge import BridgeError

router = APIRouter()

BridgeFactory = Callable[[str], Any]
_factory: Optional[BridgeFactory] = None
_bridge: Any = None
_session: Optional[str] = None
_lock = asyncio.Lock()


def configure(factory: BridgeFactory) -> None:
    """``factory(cwd)`` returns an unstarted app-server bridge."""
    global _factory
    _factory = factory


async def shutdown() -> None:
    global _bridge, _session
    if _bridge is not None:
        await _bridge.close()
    _bridge, _session = None, None


async def _catalog() -> tuple[Any, str]:
    global _bridge, _session
    async with _lock:
        if _bridge is not None and _bridge.alive and _session:
            return _bridge, _session
        if _factory is None:
            raise RuntimeError("extensions.configure() was not called")
        if _bridge is not None:
            await _bridge.close()
        bridge = _factory(str(Path.home()))
        try:
            await bridge.start()
            res = await bridge.call("session/start", {"kind": "ephemeral", "historyLimit": 1})
        except BaseException:
            await bridge.close()
            raise
        _bridge, _session = bridge, (res.get("state") or {}).get("session", {}).get("id")
        if not _session:
            raise HTTPException(502, "Vibe did not open a catalog session")
        return _bridge, _session


async def _call(method: str, params: Optional[dict] = None, timeout: float = 60) -> Any:
    bridge, sid = await _catalog()
    try:
        return await bridge.call(method, {"sessionId": sid, **(params or {})}, timeout=timeout)
    except BridgeError as e:
        raise HTTPException(502 if e.code in TRANSPORT_ERRORS else 409, e.message) from e


# ---- MCP servers and connectors

class ToggleReq(BaseModel):
    name: str = Field(min_length=1)
    source: Literal["server", "connector"]
    disabled: StrictBool
    tool_name: Optional[str] = Field(None, alias="toolName")


class AddReq(BaseModel):
    name: Optional[str] = Field(None, max_length=100)
    transport: Literal["stdio", "streamable-http", "http", "sse"] = "streamable-http"
    url: Optional[str] = Field(None, max_length=2000)
    command: Optional[str] = Field(None, max_length=1000)
    args: list[str] = []
    env: dict[str, str] = {}


class NameReq(BaseModel):
    name: str = Field(min_length=1)
    source: Literal["server", "connector"] = "server"


@router.get("/api/extensions/mcp")
async def mcp_sources() -> dict:
    res = await _call("mcp/read")
    return (res or {}).get("mcp", {})


@router.post("/api/extensions/mcp/refresh")
async def mcp_refresh() -> dict:
    await _call("mcp/refresh", timeout=120)
    return await mcp_sources()


@router.post("/api/extensions/mcp/toggle")
async def mcp_toggle(r: ToggleReq) -> dict:
    params: dict = {"name": r.name, "source": r.source, "disabled": r.disabled}
    if r.tool_name:
        params["toolName"] = r.tool_name
    await _call("mcp/toggle", params)
    return await mcp_sources()


@router.post("/api/extensions/mcp/add")
async def mcp_add(r: AddReq) -> dict:
    if r.transport == "stdio":
        if not (r.command or "").strip():
            raise HTTPException(400, "A command is required for a local (stdio) server")
        params: dict = {"transport": "stdio", "command": r.command.strip(), "args": r.args, "env": r.env}
    else:
        if not (r.url or "").startswith(("https://", "http://")):
            raise HTTPException(400, "A server URL starting with https:// is required")
        params = {"transport": r.transport, "url": r.url, "allowInsecureHttp": r.url.startswith("http://")}
    if r.name:
        params["name"] = r.name
    res = await _call("mcp/add", params, timeout=120)
    return {"name": (res or {}).get("name"), "created": bool((res or {}).get("created")), **(await mcp_sources())}


@router.post("/api/extensions/mcp/remove")
async def mcp_remove(r: NameReq) -> dict:
    await _call("mcp/remove", {"name": r.name})
    return await mcp_sources()


@router.post("/api/extensions/mcp/login")
async def mcp_login(r: NameReq) -> dict:
    """The URL to authorize a server or connector in the browser."""
    if r.source == "connector":
        url = ((await _call("connectors/auth/read", {"name": r.name})) or {}).get("url")
        if not url:
            raise HTTPException(409, "Vibe has no sign-in link for this connector right now")
        return {"url": url}
    bridge, _sid = await _catalog()
    queue = bridge.subscribe()
    try:
        login = asyncio.create_task(_call("mcp/login", {"name": r.name}, timeout=300))
        # it outlives this request when the browser flow takes over
        login.add_done_callback(lambda t: t.cancelled() or t.exception())
        deadline = asyncio.get_running_loop().time() + 20
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0 or login.done():
                break
            try:
                msg = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                break
            if msg is None:
                break
            params = msg.get("params") or {}
            if msg.get("method") == "mcp/authUrl" and params.get("name") == r.name and params.get("url"):
                # the login call keeps waiting for the browser callback in the background
                return {"url": params["url"]}
        if login.done():
            login.result()
            return {"url": None}
        raise HTTPException(504, "Vibe did not offer a sign-in link")
    finally:
        bridge.unsubscribe(queue)


@router.post("/api/extensions/mcp/logout")
async def mcp_logout(r: NameReq) -> dict:
    await _call("mcp/logout", {"name": r.name})
    return await mcp_sources()


# ---- skill catalog

class SkillIdReq(BaseModel):
    skill_id: str = Field(alias="skillId", min_length=1)


class SkillNameReq(BaseModel):
    name: str = Field(min_length=1)


class SkillEnabledReq(SkillNameReq):
    enabled: StrictBool


@router.get("/api/extensions/skills")
async def skill_catalog() -> dict:
    """Registry skills with the installed version and any update, plus the
    installed skills that are not from the registry."""
    catalog = await _call("skills/catalog", timeout=60) or {}
    installed = (await _call("skills/installed") or {}).get("skills", [])
    return {
        "catalog": catalog.get("skills", []),
        "updates": catalog.get("updates", {}),
        "authenticated": catalog.get("authenticated", True),
        "installed": [{k: s.get(k) for k in ("name", "description", "enabled", "source", "version", "skillId", "path")}
                      for s in installed],
    }


@router.post("/api/extensions/skills/install")
async def skill_install(r: SkillIdReq) -> dict:
    await _call("skills/import", {"skillId": r.skill_id}, timeout=120)
    return await skill_catalog()


@router.post("/api/extensions/skills/update")
async def skill_update(r: SkillNameReq) -> dict:
    await _call("skills/setLatest", {"name": r.name}, timeout=120)
    return await skill_catalog()


@router.post("/api/extensions/skills/enabled")
async def skill_enabled(r: SkillEnabledReq) -> dict:
    await _call("skills/setEnabled", {"name": r.name, "enabled": r.enabled})
    return await skill_catalog()


@router.post("/api/extensions/skills/remove")
async def skill_remove(r: SkillNameReq) -> dict:
    await _call("skills/remove", {"name": r.name})
    return await skill_catalog()
