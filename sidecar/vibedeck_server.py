"""VibeDeck sidecar — local control plane for the Mistral Vibe app-server + API.

Runs on http://127.0.0.1:9377. Responsibilities:
  * Drive the Vibe CLI through its native ``vibe-app-server`` JSON-RPC interface
    (sessions, turns, streaming events, approvals, diffs, worktrees, skills, MCP).
  * Serve the direct Mistral API chat surface (Chat lane) and the Studio
    playground (models, completions, usage).
  * Persist VibeDeck metadata, cost tracking, and an audit log in SQLite.
  * Serve the built frontend (./dist) on the same origin.

OPSEC: binds to 127.0.0.1 only; no telemetry; secrets resolved from env/keyring,
never logged or written to the DB.

Dev:  python3 -m uvicorn vibedeck_server:app --host 127.0.0.1 --port 9377
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import getpass
import hashlib
import json
import os
import secrets
import shutil
import time
import tomllib
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional
from weakref import WeakValueDictionary

import cloud_teleport
import git_projects
import httpx
import providers as provider_config
import skill_import
from agent_routing import AgentSettings
from agent_routing import read_settings as read_agent_settings
from agent_routing import write_settings as write_agent_settings
from codex_provider import CodexProvider
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from mistral_api import (
    api_key_status,
    chat_stream,
    completion,
    get_usage,
    list_models,
    remove_api_key,
    resolve_api_key,
    set_api_key,
)
from providers import (
    apply_provider_edit,
    list_providers,
    provider_key_status,
    remove_model,
    remove_provider,
    set_provider_key,
    upsert_model,
    validate_key,
    validate_model,
    validate_provider,
)
from providers import (
    delete_provider_key as _delete_provider_key,
)
from pydantic import BaseModel, ConfigDict, Field, StrictBool
from store import Store
from usage import UsageReader
from vibe_bridge import (
    AGENT_MODES,
    APPROVAL_DECISIONS,
    DEFAULT_AGENT,
    DEFAULT_MODEL,
    REASONING_LEVELS,
    BridgeError,
    SessionManager,
    find_app_server,
)
from vibe_sessions import LISTER_KEY, VibeSessionSync, cleanup_store_dir

PORT = int(os.environ.get("VIBEDECK_PORT", "9377"))
DATA_DIR = Path(os.environ.get("VIBEDECK_DATA", Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "vibedeck"))
DB_PATH = DATA_DIR / "vibedeck.db"
LOG_DIR = DATA_DIR / "logs"

store = Store(DB_PATH)
manager = SessionManager(log_dir=LOG_DIR)
# Mirrors the shared vibe CLI session store into the registry (see
# vibe_sessions.py) so CLI sessions appear in the sidebar and vice versa.
vsync = VibeSessionSync(store, manager, log_dir=LOG_DIR)
usage_reader = UsageReader()
codex_provider = CodexProvider()

# Per-session background tap: persists cost stats even with no UI connected.
_taps: dict[str, asyncio.Task] = {}
_stale_config: set[str] = set()
_stale_agent_policy: set[str] = set()
_session_locks = WeakValueDictionary()
_turn_locks = WeakValueDictionary()


def _session_lock(sid: str, turns: bool = False) -> asyncio.Lock:
    locks = _turn_locks if turns else _session_locks
    lock = locks.get(sid)
    if lock is None:
        lock = asyncio.Lock()
        locks[sid] = lock
    return lock


# ---------------------------------------------------------------- models

class SessionCreate(BaseModel):
    cwd: str = str(Path.home())
    agent: Optional[str] = None
    model: Optional[str] = None
    reasoning: Optional[str] = None
    lane: str = "code"          # work | code
    title: Optional[str] = None


class ApiKeyReq(BaseModel):
    key: str


class LibraryCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    name: str = Field(min_length=1, max_length=256)
    description: str = Field(default="", max_length=2000)


class SessionPatch(BaseModel):
    title: Optional[str] = None
    agent: Optional[str] = None
    model: Optional[str] = None
    reasoning: Optional[str] = None


class TurnReq(BaseModel):
    text: str
    images: list[dict] = []
    request_id: str = Field(default_factory=lambda: uuid.uuid4().hex, alias="requestId", max_length=128)


class CallbackReq(BaseModel):
    decision: str = "approve"
    feedback: Optional[str] = None
    user_input: Optional[dict] = Field(None, alias="userInput")


class GenerationReq(BaseModel):
    temperature: Optional[float] = Field(None, ge=0, le=2, allow_inf_nan=False)
    max_tokens: Optional[int] = Field(None, ge=1, strict=True)
    top_p: Optional[float] = Field(None, gt=0, le=1, allow_inf_nan=False)
    random_seed: Optional[int] = Field(None, ge=0, le=4294967295, strict=True)
    presence_penalty: Optional[float] = Field(None, ge=-2, le=2, allow_inf_nan=False)
    frequency_penalty: Optional[float] = Field(None, ge=-2, le=2, allow_inf_nan=False)
    stop: Optional[list[str]] = Field(None, max_length=8)
    json_mode: bool = False
    safe_prompt: bool = False


class ChatReq(GenerationReq):
    message: str
    model: str = DEFAULT_MODEL
    session_id: Optional[str] = None
    reasoning_effort: Optional[str] = None
    system_prompt: Optional[str] = None
    attachments: list[dict] = []
    messages: list[dict] = []


class CompletionReq(GenerationReq):
    model: str = DEFAULT_MODEL
    messages: list[dict]
    reasoning_effort: Optional[str] = None


class ConfigPatch(BaseModel):
    # Accept camelCase (what the JS frontend sends) and snake_case.
    model_config = ConfigDict(populate_by_name=True)
    default_model: Optional[str] = Field(None, alias="defaultModel")
    default_agent: Optional[str] = Field(None, alias="defaultAgent")
    default_reasoning: Optional[str] = Field(None, alias="defaultReasoning")


class ProviderModelReq(BaseModel):
    name: str
    # defaults to the provider being upserted
    provider: Optional[str] = None
    alias: str
    display_name: Optional[str] = None
    temperature: Optional[float] = None
    input_price: Optional[float] = None
    output_price: Optional[float] = None
    thinking: Optional[str] = None
    supports_images: Optional[bool] = None
    max_context_length: Optional[int] = None
    auto_compact_threshold: Optional[int] = None


class ProviderUpsertReq(BaseModel):
    name: str
    api_base: str
    api_style: Optional[str] = None
    backend: Optional[str] = None
    api_key_env_var: Optional[str] = None
    key: Optional[str] = None          # written to the keyring, never stored here
    models: list[ProviderModelReq] = []


class ProviderKeyReq(BaseModel):
    key: str


class ProviderModelPatchReq(BaseModel):
    # Upsert one model under an existing provider.
    model_config = ConfigDict(populate_by_name=True)
    name: str
    alias: str
    provider: Optional[str] = None
    display_name: Optional[str] = Field(None, alias="displayName")
    temperature: Optional[float] = None
    input_price: Optional[float] = Field(None, alias="inputPrice")
    output_price: Optional[float] = Field(None, alias="outputPrice")
    thinking: Optional[str] = None
    supports_images: Optional[bool] = Field(None, alias="supportsImages")
    max_context_length: Optional[int] = Field(None, alias="maxContextLength")
    auto_compact_threshold: Optional[int] = Field(None, alias="autoCompactThreshold")


# ---------------------------------------------------------------- helpers

def _now() -> float:
    return time.time()


def _require_key() -> str:
    key = resolve_api_key()
    if not key:
        raise HTTPException(400, "MISTRAL_API_KEY not set (env, keyring, or ~/.config/vibedeck/env)")
    return key


def _public_session(row: dict) -> dict:
    d = dict(row)
    d["warnings"] = json.loads(d.get("warnings") or "[]")
    if "costs" not in d:
        d["costs"] = store.get_costs(d["id"])
    return d


def normalize_notification(msg: dict) -> dict:
    """Map an app-server JSON-RPC notification to a clean SSE event envelope."""
    method = msg.get("method", "")
    p = msg.get("params") or {}
    if method == "history/entryAdded":
        return {"kind": "entry", "action": "add", "entry": p.get("entry", {})}
    if method == "history/entryUpdated":
        ev = {"kind": "entry", "action": "update", "entryId": p.get("entryId"),
              "patch": p.get("patch", [])}
        if p.get("entry") is not None:
            ev["entry"] = p["entry"]
        return ev
    if method == "turn/started":
        return {"kind": "turn", "status": "started", "turn": p.get("turn", {})}
    if method == "turn/completed":
        return {"kind": "turn", "status": "completed", "turn": p.get("turn", {})}
    if method == "session/statsUpdated":
        return {"kind": "stats", "stats": p.get("stats", {})}
    if method == "runtime/updated":
        return {"kind": "runtime", "runtime": p.get("runtime", {})}
    if method == "session/updated":
        return {"kind": "session", "sessionId": p.get("sessionId"), "patch": p.get("patch", [])}
    if method == "session/snapshot":
        # same shape as the initial snapshot in stream_events (the frontend's
        # SseEvent type expects session/activeCallbacks/lastEventId)
        st = p.get("state", {})
        return {"kind": "snapshot", **st, "lastEventId": st.get("eventId", 0)}
    if method == "session/childSessionUpdated":
        return {"kind": "childSession", "childSession": p.get("childSession", {})}
    if method == "callback/requested":
        return {"kind": "callback", "callback": p.get("callback", {})}
    return {"kind": "raw", "method": method, "params": p}


def _is_busy(e: BridgeError) -> bool:
    """True when the app-server refused because another process holds the
    session lease (e.g. the session is open in the vibe CLI right now)."""
    return (getattr(e, "code", None) == "conflict"
            or "already open" in str(e))


def _live_sids() -> set:
    """Session ids with a live desktop bridge (excludes the listing bridge)."""
    return {sid for sid in manager.all() if sid != LISTER_KEY}


async def _ensure_bridge(sid: str) -> tuple[Any, str]:
    async with _session_lock(sid):
        return await _open_session(sid)


async def _open_session(sid: str) -> tuple[Any, str]:
    """Return (bridge, effective_sid) for a session, spawning + resuming if needed.

    Legacy CLI sessions can migrate to a unified id on resume. Persist that
    mapping and always reuse it. Missing sessions must never become empty ones.
    """
    _registry_signature()
    row = store.get_session(sid)
    if row is None:
        # not in the registry yet — maybe a vibe CLI session opened directly
        row = await vsync.ensure_row(sid)
        if row is None:
            raise HTTPException(404, "session not found")
    bridge = manager.get(sid)
    if (bridge is not None and bridge.alive and sid in _stale_agent_policy
            and row.get("status") not in ("running", "blocked", "unknown")):
        await _stop_tap(sid)
        await manager.close(sid)
        _stale_agent_policy.discard(sid)
        bridge = None
    if bridge is not None:
        if bridge.alive:
            if sid in _stale_config and row.get("status") not in ("running", "blocked", "unknown"):
                try:
                    await bridge.reload_config(bridge.session_id or sid)
                except BridgeError:
                    raise HTTPException(503, "Could not apply provider changes. Retry while this session is idle.") from None
                _stale_config.discard(sid)
            return bridge, bridge.session_id or sid
        # the app-server process died (crash/exit): drop the dead bridge and
        # respawn below — resume reattaches to the on-disk session
        await manager.close(sid)
        await _stop_tap(sid)
    bridge = await manager.open(sid, row["cwd"])
    try:
        state = await bridge.resume_session(row.get("vibe_session_id") or sid)
    except BaseException as e:
        await manager.close(sid)
        if isinstance(e, BridgeError):
            if _is_busy(e):
                raise HTTPException(409, "Session is open in the Vibe CLI. Release it there before continuing here.") from e
            raise HTTPException(502, f"Could not resume this session: {e.message}. No replacement was created.") from e
        raise
    esid = bridge.session_id or sid
    if esid != sid:
        # legacy CLI session migrated to a unified id on resume
        store.upsert_session(sid, vibe_session_id=esid)
        store.audit("session.migrate", f"{sid} -> {esid}")
    _persist_session_state(sid, state)
    try:
        stats = (await bridge.read_stats(esid)).get("stats")
        if stats is not None:
            store.upsert_costs(sid, stats)
    except BridgeError:
        pass
    _start_tap(sid, bridge)
    _stale_config.discard(sid)
    _stale_agent_policy.discard(sid)
    return bridge, esid


def _persist_session_state(sid: str, state: dict) -> None:
    session = state.get("session", {})
    fields = {}
    for field in ("model", "reasoningEffort", "agent"):
        value = session.get(field)
        if field == "agent" and isinstance(value, dict):
            value = value.get("name")
        if field in session:
            fields["reasoning" if field == "reasoningEffort" else field] = value
    status = session.get("status", {})
    fields["status"] = status.get("type", "idle") if isinstance(status, dict) else "idle"
    store.upsert_session(sid, **fields)


async def _stop_tap(sid: str) -> None:
    tap = _taps.pop(sid, None)
    if tap is not None:
        tap.cancel()
        await asyncio.gather(tap, return_exceptions=True)


def _start_tap(sid: str, bridge) -> None:
    if sid in _taps:
        return
    q = bridge.subscribe(tap=True)

    async def run():
        recover = False
        try:
            while True:
                msg = await q.get()
                if msg is None:
                    recover = bridge.alive
                    if recover:
                        esid = bridge.session_id or sid
                        _persist_session_state(sid, (await bridge.read_session(esid)).get("state", {}))
                        stats = (await bridge.read_stats(esid)).get("stats")
                        if stats is not None:
                            row = store.get_session(sid) or {}
                            store.upsert_costs(sid, stats, f"recover:{bridge.last_event_id}", row.get("model"))
                    break
                p = msg.get("params") or {}
                if msg.get("method") == "session/statsUpdated":
                    row = store.get_session(sid) or {}
                    store.upsert_costs(sid, p.get("stats", {}),
                                       str(p.get("eventId", bridge.last_event_id)), row.get("model"))
                elif msg.get("method") == "turn/completed":
                    store.set_session_status(sid, "idle")
                elif msg.get("method") == "turn/started":
                    store.set_session_status(sid, "running")
        except (asyncio.CancelledError, BridgeError):
            pass
        finally:
            bridge.unsubscribe(q)
            if not bridge.alive:
                store.set_session_status(sid, "idle")
            if _taps.get(sid) is asyncio.current_task():
                _taps.pop(sid, None)
                if recover and bridge.alive:
                    _start_tap(sid, bridge)

    _taps[sid] = asyncio.create_task(run())


# ---------------------------------------------------------------- app

# Idle bridges (app-server processes) are reaped after this long without any
# RPC or UI subscriber, so a long-lived desktop session doesn't accumulate one
# Python process per session. Reaped sessions respawn + resume on next access.
# Kept short on purpose: a live bridge holds the session's lease in the shared
# vibe store, and releasing it quickly is what lets the user switch a session
# back to the vibe CLI (or POST /release to hand it over immediately).
_IDLE_REAP_SECONDS = 120


async def _reap_idle_bridges() -> None:
    while True:
        await asyncio.sleep(60)
        try:
            for sid, bridge in list(manager.all().items()):
                async with _session_lock(sid, turns=True), _session_lock(sid):
                    if manager.get(sid) is not bridge:
                        continue
                    if not bridge.alive:
                        await manager.close(sid)
                        await _stop_tap(sid)
                        continue
                    if bridge.has_ui_subscribers:
                        continue
                    if time.time() - bridge.last_activity < _IDLE_REAP_SECONDS:
                        continue
                    row = store.get_session(sid)
                    if row is not None and row.get("status") in ("running", "blocked", "unknown"):
                        continue  # never reap mid-turn
                    store.audit("bridge.reap", f"{sid} idle>{_IDLE_REAP_SECONDS}s")
                    await manager.close(sid)
                    await _stop_tap(sid)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass  # reaping is best-effort; never kill the loop


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.audit("boot", f"vibedeck sidecar on :{PORT}")
    try:
        provider_config.sync_subagents()
    except (ValueError, OSError):
        store.audit("agents.setup_failed", "Check Subagents in Settings → Config to finish setup.")
    reaper = asyncio.create_task(_reap_idle_bridges())
    yield
    reaper.cancel()
    await asyncio.gather(reaper, return_exceptions=True)
    await manager.close_all()
    await codex_provider.close()
    taps = list(_taps.values())
    for t in taps:
        t.cancel()
    await asyncio.gather(*taps, return_exceptions=True)
    _taps.clear()
    _stale_config.clear()
    _stale_agent_policy.clear()


app = FastAPI(title="VibeDeck Sidecar", lifespan=lifespan)
LOCAL_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173",
                 f"http://localhost:{PORT}", f"http://127.0.0.1:{PORT}",
                 "tauri://localhost", "http://tauri.localhost"}
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(LOCAL_ORIGINS),
    allow_methods=["*"], allow_headers=["*"],
)


@app.middleware("http")
async def local_requests(request: Request, call_next):
    from urllib.parse import urlsplit
    try:
        host = urlsplit("http://" + request.headers.get("host", ""))
        valid = (host.hostname in ("127.0.0.1", "localhost", "::1")
                 and host.port in (PORT, 5173) and not host.username and not host.password
                 and not host.path and not host.query and not host.fragment)
    except ValueError:
        valid = False
    if not valid:
        return JSONResponse({"detail": "Invalid local Host"}, status_code=400)
    origin = request.headers.get("origin")
    if origin is not None and origin not in LOCAL_ORIGINS:
        return JSONResponse({"detail": "Untrusted Origin"}, status_code=403)
    return await call_next(request)


@app.get("/api/health")
async def health() -> dict:
    kstat = api_key_status()
    try:
        srv = find_app_server()
        app_server = True
    except FileNotFoundError:
        srv = None
        app_server = False
    return {
        "ok": True,
        "port": PORT,
        "app_server": app_server,
        "app_server_path": srv,
        "vibe_cli": shutil.which("vibe") is not None,
        "api_key": kstat["present"],
        "api_key_source": kstat["source"],
        "default_model": DEFAULT_MODEL,
        "default_agent": DEFAULT_AGENT,
        "version": "1.1.0",
        "user": getpass.getuser(),
    }


# ---- API key management (add / remove at will; the key itself is never returned)

@app.get("/api/settings/api-key")
async def get_api_key() -> dict:
    return api_key_status()


@app.put("/api/settings/api-key")
async def put_api_key(r: ApiKeyReq) -> dict:
    try:
        set_api_key(r.key)
    except ValueError as e:
        raise HTTPException(400, str(e))
    store.audit("api_key.set", "key updated via settings")
    return api_key_status()


@app.delete("/api/settings/api-key")
async def delete_api_key() -> dict:
    removed = remove_api_key()
    store.audit("api_key.remove", f"stored key removed: {removed}")
    return api_key_status()


# ---- providers (multi-provider: add any AI provider, use its models freely
# or via provider-pinned subagents; keys live in the system keyring)

def _invalidate_vibe_models() -> None:
    """Provider/model changes alter the app-server's model registry."""
    global _vibe_models_cache, _registry_generation
    _vibe_models_cache = None
    _registry_generation += 1


@app.get("/api/providers")
async def get_providers() -> dict:
    view = list_providers()
    view["presets"] = [{**p, "api_base": f"http://127.0.0.1:{PORT}/api/codex/v1"} if p["name"] == "codex" else p for p in view["presets"]]
    return view


@app.get("/api/codex/account")
async def codex_account() -> dict:
    try:
        return await codex_provider.account()
    except (BridgeError, OSError):
        return {"installed": shutil.which("codex") is not None, "connected": False,
                "detail": "Install the official Codex CLI or check its local app-server."}


@app.post("/api/codex/login")
async def codex_login() -> dict:
    try:
        return await codex_provider.login()
    except (BridgeError, OSError):
        raise HTTPException(502, "Codex sign-in could not start. Install/update the official Codex CLI.") from None


def _require_codex_token(request: Request) -> None:
    token = provider_config.provider_key("VIBEDECK_CODEX_TOKEN")
    if not token or not secrets.compare_digest(request.headers.get("Authorization", ""), f"Bearer {token}"):
        raise HTTPException(401, "Codex provider authentication required")


@app.get("/api/codex/v1/models")
async def codex_models(request: Request) -> dict:
    _require_codex_token(request)
    try:
        return {"data": await codex_provider.models()}
    except (BridgeError, OSError):
        raise HTTPException(502, "Could not read Codex models. Check native Codex sign-in.") from None


@app.post("/api/codex/v1/chat/completions")
async def codex_completion(request: Request):
    _require_codex_token(request)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "Invalid JSON request") from None
    if (not isinstance(body, dict) or not isinstance(body.get("model"), str) or not body["model"].strip()
            or not isinstance(body.get("messages"), list) or not body["messages"]
            or any(not isinstance(m, dict) or m.get("role") not in ("system", "developer", "user", "assistant", "tool")
                   or not isinstance(m.get("content"), (str, type(None))) for m in body["messages"])
            or ("max_tokens" in body and (type(body["max_tokens"]) is not int or body["max_tokens"] < 1))
            or body.get("stream") is not True or not isinstance(body.get("tools", []), list)
            or any(not isinstance(t, dict) or t.get("type") != "function" or not isinstance(t.get("function"), dict)
                   or not isinstance(t["function"].get("name"), str) for t in body.get("tools", []))):
        raise HTTPException(400, "Codex provider requires text messages, function tools and streaming")
    chunks = codex_provider.chunks(body)
    try:
        first = await anext(chunks)
    except (BridgeError, OSError, TimeoutError):
        await chunks.aclose()
        # Non-retryable status: never replay a paid turn on expired auth/tools.
        raise HTTPException(400, "Codex request failed. Check sign-in/model access or start a new turn if a tool continuation expired.") from None
    return StreamingResponse(codex_provider.stream(body, chunks=chunks, first=first), media_type="text/event-stream")


@app.get("/api/providers/{name}/catalog")
async def provider_catalog(name: str) -> dict:
    provider = next((p for p in list_providers()["providers"] if p["name"] == name), None)
    if provider is None:
        raise HTTPException(404, "Provider not found")
    try:
        key = provider_config.provider_key(provider["apiKeyEnvVar"])
        if provider["apiKeyEnvVar"] and not key:
            raise HTTPException(400, "Configure this provider's API key first")
        headers = {"Authorization": f"Bearer {key}"} if key else {}
        suffix = "/models"
        if provider["apiStyle"] == "anthropic":
            headers = {"x-api-key": key or "", "anthropic-version": "2023-06-01"}
            suffix = "/v1/models"
        async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
            response = await client.get(provider["apiBase"].rstrip("/") + suffix, headers=headers)
        if response.status_code != 200:
            raise HTTPException(502, f"Provider returned HTTP {response.status_code}. Check the key and base URL; some services require entering model IDs manually.")
        data = response.json().get("data", [])
        if not isinstance(data, list):
            raise ValueError
        return {"models": [{"id": row["id"], "name": row.get("display_name", row["id"])}
                           for row in data if isinstance(row, dict) and isinstance(row.get("id"), str)]}
    except HTTPException:
        raise
    except (httpx.HTTPError, ValueError, OSError):
        raise HTTPException(502, "Could not read this provider's models. Check its connection or enter a model ID manually.") from None


@app.put("/api/providers")
async def put_provider(r: ProviderUpsertReq) -> dict:
    try:
        provider = validate_provider(r.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))
    if provider["name"] == "codex":
        if (provider["api_base"] != f"http://127.0.0.1:{PORT}/api/codex/v1" or
                provider["api_key_env_var"] != "VIBEDECK_CODEX_TOKEN" or provider["api_style"] != "openai"):
            raise HTTPException(400, "Codex OAuth must use VibeDeck's local native bridge")
        try:
            if not provider_config.provider_key("VIBEDECK_CODEX_TOKEN"):
                set_provider_key("VIBEDECK_CODEX_TOKEN", secrets.token_urlsafe(32))
        except Exception:
            raise HTTPException(503, "Unlock your system keyring to connect Codex safely.") from None
    known = {p["name"] for p in list_providers()["providers"]}
    models = []
    for m in r.models:
        payload = m.model_dump()
        payload["provider"] = payload["provider"] or provider["name"]
        try:
            models.append(validate_model(payload, known | {provider["name"]}))
        except ValueError as e:
            raise HTTPException(400, str(e))
    key = None
    if any(m["provider"] != provider["name"] for m in models):
        raise HTTPException(400, "models must belong to the provider being edited")
    existing = {m["alias"]: m["provider"] for p in list_providers()["providers"] for m in p["models"]}
    if any(m["alias"] in existing and existing[m["alias"]] != provider["name"] for m in models):
        raise HTTPException(400, "model alias belongs to another provider")
    if r.key is not None:
        if not provider["api_key_env_var"]:
            raise HTTPException(400, "set api_key_env_var before storing a key")
        try:
            key = validate_key(r.key)
        except ValueError as e:
            raise HTTPException(400, str(e))
        try:
            old_key = provider_config._keyring_get(provider_config.KEYRING_SERVICE, provider["api_key_env_var"])
            set_provider_key(provider["api_key_env_var"], key)
        except Exception:
            raise HTTPException(503, "Unlock the system keyring to save this provider key.") from None
        store.audit("provider.key_set", f"{provider['name']} key stored in keyring")
    try:
        apply_provider_edit(provider, models)
    except (ValueError, OSError) as e:
        if key is not None:
            try:
                if old_key is None:
                    _delete_provider_key(provider["api_key_env_var"])
                else:
                    set_provider_key(provider["api_key_env_var"], old_key)
            except Exception:
                raise HTTPException(503, "Provider edit failed and keyring rollback could not finish. Unlock the keyring and check the provider key.") from None
        raise HTTPException(409, str(e)) from e
    await _providers_changed()
    store.audit("provider.upsert", f"{provider['name']} models={len(models)}")
    return list_providers()


@app.delete("/api/providers/{name}")
async def delete_provider(name: str) -> dict:
    view = list_providers()
    target = next((p for p in view["providers"] if p["name"] == name), None)
    if target is None:
        raise HTTPException(404, f"provider not found: {name}")
    if target.get("builtin"):
        raise HTTPException(400, "the built-in mistral provider cannot be removed")
    aliases = {m["alias"] for m in target["models"]}
    if target.get("apiKeyEnvVar") and not any(p["name"] != name and p["apiKeyEnvVar"] == target["apiKeyEnvVar"] for p in view["providers"]):
        try:
            _delete_provider_key(target["apiKeyEnvVar"])
        except Exception:
            raise HTTPException(503, "Provider not removed: keyring cleanup failed. Unlock the keyring and retry; some stored keys may already be removed.") from None
        store.audit("provider.key_remove", f"{name} key removed from keyring")
    try:
        removed = remove_provider(name)
    except (ValueError, OSError):
        raise HTTPException(409, "Provider configuration could not be updated. Its stored key may already be removed; check the key before using this provider.") from None
    if store.get_config("default_model", DEFAULT_MODEL) in aliases:
        store.set_config("default_model", DEFAULT_MODEL)
    await _providers_changed()
    store.audit("provider.remove", f"{name} removed={removed}")
    return list_providers()


@app.get("/api/providers/{name}/key")
async def get_provider_key(name: str) -> dict:
    view = list_providers()
    target = next((p for p in view["providers"] if p["name"] == name), None)
    if target is None:
        raise HTTPException(404, f"provider not found: {name}")
    # status only — the key itself is never returned
    return {"provider": name, "apiKeyEnvVar": target["apiKeyEnvVar"],
            "key": provider_key_status(target["apiKeyEnvVar"])}


@app.put("/api/providers/{name}/key")
async def put_provider_key(name: str, r: ProviderKeyReq) -> dict:
    view = list_providers()
    target = next((p for p in view["providers"] if p["name"] == name), None)
    if target is None:
        raise HTTPException(404, f"provider not found: {name}")
    if not target["apiKeyEnvVar"]:
        raise HTTPException(400, f"provider {name} has no api_key_env_var configured")
    try:
        key = validate_key(r.key)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        set_provider_key(target["apiKeyEnvVar"], key)
    except Exception:
        raise HTTPException(503, "Unlock the system keyring to save this provider key.") from None
    store.audit("provider.key_set", f"{name} key stored in keyring")
    return {"provider": name, "apiKeyEnvVar": target["apiKeyEnvVar"],
            "key": provider_key_status(target["apiKeyEnvVar"])}


@app.delete("/api/providers/{name}/key")
async def delete_provider_key(name: str) -> dict:
    view = list_providers()
    target = next((p for p in view["providers"] if p["name"] == name), None)
    if target is None:
        raise HTTPException(404, f"provider not found: {name}")
    if target["apiKeyEnvVar"]:
        try:
            _delete_provider_key(target["apiKeyEnvVar"])
        except Exception:
            raise HTTPException(503, "Keyring cleanup failed. Unlock the keyring and retry; some stored keys may already be removed.") from None
    store.audit("provider.key_remove", f"{name} key removed from keyring")
    return {"provider": name, "apiKeyEnvVar": target["apiKeyEnvVar"],
            "key": provider_key_status(target["apiKeyEnvVar"])}


@app.put("/api/providers/{name}/models")
async def put_provider_model(name: str, r: ProviderModelPatchReq) -> dict:
    view = list_providers()
    target = next((p for p in view["providers"] if p["name"] == name), None)
    if target is None:
        raise HTTPException(404, f"provider not found: {name}")
    payload = r.model_dump()
    payload["provider"] = r.provider or name
    if payload["provider"] != name:
        raise HTTPException(400, "model must belong to the provider in the URL")
    for provider in view["providers"]:
        if provider["name"] != name and any(m["alias"] == r.alias for m in provider["models"]):
            raise HTTPException(400, "model alias belongs to another provider")
    try:
        model = validate_model(payload, {p["name"] for p in view["providers"]})
    except ValueError as e:
        raise HTTPException(400, str(e))
    upsert_model(model)
    await _providers_changed()
    store.audit("provider.model_upsert", f"{name}/{model['alias']}")
    return list_providers()


@app.delete("/api/providers/{name}/models/{alias}")
async def delete_provider_model(name: str, alias: str) -> dict:
    view = list_providers()
    target = next((p for p in view["providers"] if p["name"] == name), None)
    if target is None:
        raise HTTPException(404, f"provider not found: {name}")
    if not any(m["alias"] == alias for m in target["models"]):
        raise HTTPException(404, "model not found under this provider")
    removed = remove_model(alias)
    if store.get_config("default_model", DEFAULT_MODEL) == alias:
        store.set_config("default_model", DEFAULT_MODEL)
    await _providers_changed()
    store.audit("provider.model_remove", f"{name}/{alias} removed={removed}")
    return list_providers()


async def _providers_changed() -> None:
    try:
        provider_config.sync_subagents()
    except (ValueError, OSError) as exc:
        raise HTTPException(409, "Provider saved, but provider routing could not be updated. Check write access to VIBE_HOME.") from exc
    _invalidate_vibe_models()
    global _agents_cache
    _agents_cache = None
    for sid, bridge in manager.all().items():
        if sid == LISTER_KEY or not bridge.alive or not bridge.session_id:
            continue
        _stale_config.add(sid)


# ---- config

# Model aliases the vibe CLI's app-server accepts for config/model/write —
# read once per sidecar process from a throwaway bridge (the registry only
# changes when the vibe CLI itself is updated). Empty when unavailable.
_vibe_models_cache: Optional[list[dict]] = None
_vibe_models_lock = asyncio.Lock()
_vibe_models_signature: Optional[tuple] = None
_registry_generation = 0
_observed_registry_signature: Optional[tuple] = None


def _registry_signature() -> tuple:
    global _observed_registry_signature
    config = provider_config.vibe_config_path()
    paths = [config, *sorted((config.parent / "agents").glob("*.toml"))]
    try:
        paths.append(Path(find_app_server()))
    except FileNotFoundError:
        pass
    signature = [_registry_generation]
    for path in paths:
        try:
            stat = path.stat()
            signature.append((str(path), stat.st_mtime_ns, stat.st_size, stat.st_ino))
        except OSError:
            signature.append((str(path), None))
    result = tuple(signature)
    if _observed_registry_signature is not None and result != _observed_registry_signature:
        _stale_config.intersection_update(manager.all())
        _stale_config.update(sid for sid, bridge in manager.all().items()
                             if sid != LISTER_KEY and bridge.alive and bridge.session_id)
    _observed_registry_signature = result
    return result


async def _read_vibe_models() -> list[dict]:
    async with _vibe_models_lock:
        return await _fetch_vibe_models()


async def _fetch_vibe_models() -> list[dict]:
    global _vibe_models_cache, _vibe_models_signature
    signature = _registry_signature()
    if _vibe_models_cache is not None and signature == _vibe_models_signature:
        return _vibe_models_cache
    out: list[dict] = []
    try:
        bridge = await manager.spawn(str(Path.home()), key="vibe-models-probe")
        try:
            cfg = await bridge.read_config()
            for m in (cfg.get("config", {}) or {}).get("models", []) or []:
                alias = m.get("alias") or m.get("name")
                if alias:
                    out.append({
                        "id": alias,
                        "name": m.get("displayName") or alias,
                        "supportsImages": bool(m.get("supportsImages")),
                        "thinkingLevels": m.get("thinkingLevels") or [],
                        "thinking": m.get("thinking"),
                        "maxContextLength": m.get("maxContextLength"),
                        "autoCompactThreshold": m.get("autoCompactThreshold"),
                    })
        finally:
            await bridge.close()
    except Exception:
        out = []
    _vibe_models_cache = (out or None) if signature == _registry_signature() else None
    _vibe_models_signature = signature
    return out


# Agent profiles known to the vibe CLI (built-in modes + custom profiles from
# ~/.vibe/agents, including subagent-type fleet workers). Read once per sidecar
# process from a throwaway bridge; ?refresh=1 bypasses the cache.
_agents_cache: Optional[list[dict]] = None
_agents_lock = asyncio.Lock()
_agents_signature: Optional[tuple] = None


async def _read_agents(refresh: bool = False) -> list[dict]:
    async with _agents_lock:
        return await _fetch_agents(refresh)


async def _fetch_agents(refresh: bool = False) -> list[dict]:
    global _agents_cache, _agents_signature
    signature = _registry_signature()
    if _agents_cache is not None and not refresh and signature == _agents_signature:
        return _agents_cache
    out: list[dict] = []
    try:
        bridge = await manager.spawn(str(Path.home()), key="agents-probe")
        try:
            data = await bridge.list_agents()
            for a in (data.get("agents") or []):
                out.append({
                    "name": a.get("name", ""),
                    "displayName": a.get("displayName") or a.get("name", ""),
                    "description": a.get("description") or "",
                    "safety": a.get("safety") or "",
                    "agentType": a.get("agentType") or "agent",
                })
        finally:
            await bridge.close()
    except Exception:
        out = []
    _agents_cache = (out or None) if signature == _registry_signature() else None
    _agents_signature = signature
    return out


async def _known_agent_names() -> set[str]:
    """Every agent name a session may run as (modes + subagent profiles)."""
    names = set(AGENT_MODES)
    try:
        for a in await _read_agents():
            if a.get("name") and a.get("agentType") != "subagent":
                names.add(a["name"])
    except Exception:
        pass
    return names


@app.get("/api/config")
async def get_config() -> dict:
    return {
        "defaultModel": store.get_config("default_model", DEFAULT_MODEL),
        "defaultAgent": store.get_config("default_agent", DEFAULT_AGENT),
        "defaultReasoning": store.get_config("default_reasoning", None),
        "agentModes": list(AGENT_MODES),
        "reasoningLevels": list(REASONING_LEVELS),
        "approvalDecisions": list(APPROVAL_DECISIONS),
        "vibeModels": await _read_vibe_models(),
    }


@app.patch("/api/config")
async def patch_config(c: ConfigPatch) -> dict:
    supplied = c.model_fields_set
    if c.default_agent is not None:
        known = await _known_agent_names()
        if c.default_agent not in known:
            raise HTTPException(400, f"unknown agent '{c.default_agent}'. Available: {', '.join(sorted(known))}")
    if c.default_reasoning is not None and c.default_reasoning not in REASONING_LEVELS:
        raise HTTPException(400, f"reasoning must be one of {REASONING_LEVELS}")
    if c.default_model is not None:
        models = await _read_vibe_models()
        if models and c.default_model not in {m["id"] for m in models}:
            raise HTTPException(400, "unknown Vibe model alias")
    for field in supplied:
        value = getattr(c, field)
        if value is None and field != "default_reasoning":
            raise HTTPException(400, f"{field} cannot be empty")
    for field in supplied:
        store.set_config(field, getattr(c, field))
    store.audit("config", ",".join(sorted(supplied)))
    return await get_config()

# ---- sessions

@app.post("/api/sessions")
async def create_session(s: SessionCreate) -> dict:
    s.agent = s.agent or store.get_config("default_agent", DEFAULT_AGENT)
    s.model = s.model or store.get_config("default_model", DEFAULT_MODEL)
    if "reasoning" not in s.model_fields_set:
        s.reasoning = store.get_config("default_reasoning", None)
    if s.reasoning is not None and s.reasoning not in REASONING_LEVELS:
        raise HTTPException(400, "invalid reasoning level")
    known = await _known_agent_names()
    if s.agent not in known:
        raise HTTPException(
            400, f"unknown agent '{s.agent}'. Available: {', '.join(sorted(known))}")
    if s.lane not in ("work", "code"):
        raise HTTPException(400, "lane must be 'work' or 'code'")
    cwd = str(Path(s.cwd or Path.home()).expanduser().resolve())
    if not Path(cwd).is_dir():
        raise HTTPException(400, f"cwd not found: {cwd}")
    bridge = None
    try:
        bridge = await manager.spawn(cwd, key=f"new-{uuid.uuid4().hex[:8]}")
        await bridge.start_session()
    except (BridgeError, FileNotFoundError, OSError) as e:
        if bridge is not None:
            await bridge.close()
        raise HTTPException(502, f"failed to start vibe session: {e}")
    sid = bridge.session_id
    manager.register(sid, bridge)
    # Apply model and agent independently: a failure in one must not skip the
    # other, and the caller must hear about it instead of silently running on
    # defaults (wrong model = wrong cost/capability, wrong agent = wrong
    # approval posture).
    warnings: list[str] = []
    try:
        await bridge.set_model(sid, s.model, s.reasoning)
    except BridgeError as e:
        warnings.append(f"model '{s.model}' not applied: {e.message}")
    try:
        await bridge.set_agent(sid, s.agent)
    except BridgeError as e:
        warnings.append(f"agent '{s.agent}' not applied: {e.message}")
    try:
        state = (await bridge.read_session(sid)).get("state", {})
    except BridgeError as e:
        await manager.close(sid)
        raise HTTPException(502, f"Session {sid} was created but could not be read. Refresh the session list.") from e
    effective = state.get("session", {})
    agent = effective.get("agent")
    if isinstance(agent, dict):
        agent = agent.get("name")
    title = s.title or f"Session in {Path(cwd).name}"
    store.upsert_session(sid, title=title, cwd=cwd,
                         agent=agent or (None if any(w.startswith("agent") for w in warnings) else s.agent),
                         model=effective.get("model") or (None if any(w.startswith("model") for w in warnings) else s.model),
                         reasoning=effective.get("reasoningEffort", s.reasoning), lane=s.lane,
                         status="idle", warnings=json.dumps(warnings))
    store.upsert_costs(sid, {})
    store.audit("session.create", f"{sid} cwd={cwd} agent={s.agent} model={s.model}")
    _start_tap(sid, bridge)
    row = store.get_session(sid)
    out = _public_session(row)
    if warnings:
        out["warnings"] = warnings
        store.audit("session.create.warning", f"{sid} {'; '.join(warnings)}")
    return out


@app.get("/api/sessions")
async def list_sessions() -> dict:
    # pick up vibe CLI sessions (and external renames/activity) from the
    # shared session store; never let a listing failure break the sidebar
    try:
        await vsync.sync(live_sids=_live_sids())
    except Exception:
        pass
    rows = store.list_sessions_with_costs()
    return {"sessions": [_public_session(r) for r in rows]}


@app.get("/api/sessions/{sid}")
async def get_session(sid: str) -> dict:
    row = store.get_session(sid)
    if row is None:
        # maybe a vibe CLI session opened directly (deep link)
        row = await vsync.ensure_row(sid)
    if row is None:
        raise HTTPException(404, "session not found")
    out = _public_session(row)
    bridge = manager.get(sid)
    out["live"] = bridge is not None and bridge.alive
    if bridge is not None and bridge.alive:
        try:
            out["runtime"] = await bridge.read_runtime(bridge.session_id or sid)
        except BridgeError:
            out["runtime"] = None
    return out


@app.delete("/api/sessions/{sid}")
async def delete_session(sid: str) -> dict:
    async with _session_lock(sid, turns=True), _session_lock(sid):
        return await _delete_session(sid)


async def _delete_session(sid: str) -> dict:
    row = store.get_session(sid)
    if row is None:
        row = await vsync.ensure_row(sid)
    if row is None:
        raise HTTPException(404, "session not found")
    bridge = manager.get(sid)
    if bridge is not None and not bridge.alive:
        await manager.close(sid)
        bridge = None
    if bridge is None:
        # no live bridge: open one so vibe's own session store can be cleaned
        # up too — best effort. No resume: deleting must not migrate a legacy
        # CLI session into a new unified one just to remove it.
        try:
            bridge = await manager.open(sid, row["cwd"])
        except Exception:
            bridge = None
    if bridge is None:
        raise HTTPException(502, "Could not connect to Vibe; this session was not deleted")
    failures = []
    if bridge is not None:
        # remove every store entry this row represents: the effective
        # (possibly migrated) id and the original id. No session/stop here:
        # the delete RPC already closes a live session, and stopping an
        # attached session takes the whole app-server process down with it.
        targets = {sid, row.get("vibe_session_id") or "", bridge.session_id or ""}
        for target in targets:
            if not target:
                continue
            deleted = False
            try:
                await bridge.delete_session(target)
                deleted = True
            except BridgeError as e:
                if str(e.code) not in ("not_found", "session_not_found"):
                    failures.append(f"{target}: {e.message}")
                store.audit("session.delete.target",
                            f"{target[:8]} error: {e}")
            if deleted:
                cleanup_store_dir(target)
        await manager.close(sid)
    await _stop_tap(sid)
    if failures:
        raise HTTPException(502, "Deletion was incomplete; retry. " + "; ".join(failures))
    store.delete_session(sid)
    store.audit("session.delete", sid)
    return {"ok": True}


@app.patch("/api/sessions/{sid}")
async def patch_session(sid: str, p: SessionPatch) -> dict:
    async with _session_lock(sid, turns=True), _session_lock(sid):
        return await _patch_session(sid, p)


async def _patch_session(sid: str, p: SessionPatch) -> dict:
    if p.reasoning is not None and p.reasoning not in REASONING_LEVELS:
        raise HTTPException(400, "invalid reasoning level")
    if p.agent is not None and p.agent not in await _known_agent_names():
        raise HTTPException(400, "unknown agent")
    row = store.get_session(sid)
    if row is None:
        raise HTTPException(404, "session not found")
    bridge, esid = await _open_session(sid)
    row = store.get_session(sid)
    if any(field in p.model_fields_set for field in ("model", "agent", "reasoning")) and row.get("status") in ("running", "blocked", "unknown"):
        raise HTTPException(409, "Wait for this session to become idle before changing its model or agent.")
    if p.title is not None:
        # rename every store entry this row represents (a migrated legacy
        # session lives under both ids)
        try:
            await bridge.rename_session(esid, p.title)
        except BridgeError as e:
            raise HTTPException(502, e.message) from e
        if esid != sid:
            try:
                await bridge.rename_session(sid, p.title)
            except BridgeError as e:
                store.audit("session.rename.legacy", str(e.code))
        store.upsert_session(sid, title=p.title)
        store.audit("session.rename", f"{sid} -> {p.title}")
    if p.agent is not None:
        known = await _known_agent_names()
        if p.agent not in known:
            raise HTTPException(
                400, f"unknown agent '{p.agent}'. Available: {', '.join(sorted(known))}")
        try:
            await bridge.set_agent(esid, p.agent)
        except BridgeError as e:
            raise HTTPException(502, e.message)
        store.upsert_session(sid, agent=p.agent)
    if p.model is not None:
        try:
            await bridge.set_model(esid, p.model, p.reasoning)
        except BridgeError as e:
            # the app-server rejects unknown model aliases — surface its
            # message (which lists the accepted aliases) instead of a 500
            raise HTTPException(502, e.message)
        store.upsert_session(sid, model=p.model, reasoning=p.reasoning)
    if "reasoning" in p.model_fields_set and p.model is None:
        try:
            await bridge.set_model(esid, row.get("model") or DEFAULT_MODEL, p.reasoning)
        except BridgeError as e:
            raise HTTPException(502, e.message)
        store.upsert_session(sid, reasoning=p.reasoning)
    _persist_session_state(sid, (await bridge.read_session(esid)).get("state", {}))
    return _public_session(store.get_session(sid))


@app.post("/api/sessions/{sid}/stop")
async def stop_session(sid: str) -> dict:
    bridge, esid = await _ensure_bridge(sid)
    try:
        await bridge.stop_session(esid, reason="user requested")
    except BridgeError as e:
        raise HTTPException(502, e.message)
    store.set_session_status(sid, "stopped")
    store.audit("session.stop", sid)
    return {"ok": True}


@app.post("/api/sessions/{sid}/resume")
async def resume_session(sid: str) -> dict:
    await _ensure_bridge(sid)
    return _public_session(store.get_session(sid))


@app.post("/api/sessions/{sid}/release")
async def release_session(sid: str) -> dict:
    async with _session_lock(sid, turns=True), _session_lock(sid):
        return await _release_session(sid)


async def _release_session(sid: str) -> dict:
    """Hand a session back to the vibe CLI: close the desktop bridge so the
    app-server releases the session lease in the shared store. The session
    stays in the registry; the CLI can resume it immediately afterwards."""
    row = store.get_session(sid)
    if row is None:
        raise HTTPException(404, "session not found")
    # A turn that just produced its output may not have flipped the status
    # back to idle yet (the tap reacts to turn/completed) — give it a moment
    # before refusing. Closing the bridge mid-turn would kill the turn.
    deadline = time.time() + 15
    while row.get("status") in ("running", "blocked") and time.time() < deadline:
        await asyncio.sleep(0.5)
        row = store.get_session(sid)
        if row is None:
            raise HTTPException(404, "session not found")
    if row.get("status") in ("running", "blocked"):
        raise HTTPException(409, "session has an active turn — stop it first")
    bridge = manager.get(sid)
    if bridge is not None:
        await manager.close(sid)
    await _stop_tap(sid)
    store.audit("session.release", sid)
    return {"ok": True, "resumeId": row.get("vibe_session_id") or sid}


# ---- turns

@app.post("/api/sessions/{sid}/turns")
async def send_turn(sid: str, t: TurnReq) -> dict:
    if not t.text.strip() and not t.images:
        raise HTTPException(400, "message is empty")
    if len(t.images) > 8:
        raise HTTPException(400, "attach up to 8 images")
    for image in t.images:
        source = image.get("source") or {}
        if not isinstance(source, dict):
            raise HTTPException(400, "image source must be an inline image object")
        data = source.get("data")
        if source.get("kind") != "inline" or image.get("mimeType") not in ("image/png", "image/jpeg", "image/webp", "image/gif") or not isinstance(data, str) or len(data) > 14 * 1024 * 1024:
            raise HTTPException(400, "images must be PNG, JPEG, WebP or GIF up to 10 MB")
        try:
            if len(base64.b64decode(data, validate=True)) > 10 * 1024 * 1024:
                raise ValueError("too large")
        except (ValueError, binascii.Error):
            raise HTTPException(400, "invalid image data") from None
    payload_hash = hashlib.sha256(json.dumps([t.text, t.images], sort_keys=True).encode()).hexdigest()
    async with _session_lock(sid, turns=True):
        previous = store.get_turn_request(sid, t.request_id)
        if previous:
            if previous["payload_hash"] != payload_hash:
                raise HTTPException(409, "This request ID belongs to a different message")
            if previous["response"] is not None:
                return json.loads(previous["response"])
            raise HTTPException(409, "The previous send may have been accepted. Review the conversation before sending a new message.")
        bridge, esid = await _ensure_bridge(sid)
        row = store.get_session(sid)
        if row and row.get("status") == "unknown":
            _persist_session_state(sid, (await bridge.read_session(esid)).get("state", {}))
            row = store.get_session(sid)
            if row.get("status") not in ("running", "blocked", "unknown") and sid in _stale_config:
                bridge, esid = await _ensure_bridge(sid)
        if row and row.get("status") in ("running", "blocked"):
            raise HTTPException(409, "This session already has an active turn")
        if t.images:
            model = next((m for m in await _read_vibe_models() if m["id"] == row.get("model")), None)
            if model and not model["supportsImages"]:
                raise HTTPException(400, "The selected model does not support images. Choose a vision model.")
        store.set_turn_request(sid, t.request_id, payload_hash)
        store.set_session_status(sid, "running")
        try:
            res = await bridge.send_turn(esid, t.text, t.images, t.request_id)
        except BridgeError as e:
            if e.code not in ("timeout", "closed", "process_exited"):
                store.forget_turn_request(sid, t.request_id)
            # A timed-out turn may have been accepted: do not automatically resend.
            try:
                state = (await bridge.read_session(esid)).get("state", {})
                _persist_session_state(sid, state)
            except BridgeError:
                store.set_session_status(sid, "unknown")
            raise HTTPException(502, e.message + ". Check the conversation before retrying.") from e
        store.audit("turn.start", sid)
        result = {"turn": res.get("turn", {}), "lastEventId": res.get("lastEventId")}
        store.set_turn_request(sid, t.request_id, payload_hash, result)
        return result


@app.post("/api/sessions/{sid}/interrupt")
async def interrupt(sid: str, turn_id: str = Query(...)) -> dict:
    bridge, esid = await _ensure_bridge(sid)
    try:
        await bridge.interrupt_turn(esid, turn_id)
    except BridgeError as e:
        raise HTTPException(502, e.message)
    return {"ok": True}


# ---- approvals

@app.post("/api/sessions/{sid}/callbacks/{callback_id}")
async def resolve_callback(sid: str, callback_id: str, r: CallbackReq) -> dict:
    bridge, esid = await _ensure_bridge(sid)
    try:
        await bridge.resolve_callback(esid, callback_id, r.decision, r.feedback, r.user_input)
    except BridgeError as e:
        raise HTTPException(502, e.message)
    store.audit("callback", f"{sid} {callback_id} {r.decision}")
    return {"ok": True}


# ---- history + events

@app.get("/api/sessions/{sid}/history")
async def get_history(sid: str, before: Optional[str] = None) -> dict:
    bridge, esid = await _ensure_bridge(sid)
    try:
        res = await bridge.read_session(esid, before)
    except BridgeError as e:
        raise HTTPException(502, e.message)
    state = res.get("state", {})
    return {
        "session": state.get("session", {}),
        "history": state.get("history", []),
        "turns": state.get("turns", []),
        "historyBeforeCursor": state.get("historyBeforeCursor"),
        "childSessions": state.get("childSessions", []),
        "activeCallbacks": state.get("activeCallbacks", []),
        "lastEventId": state.get("eventId", bridge.last_event_id),
    }


@app.get("/api/sessions/{sid}/events")
async def stream_events(sid: str, after: Optional[int] = None) -> StreamingResponse:
    """One authoritative snapshot, followed by watermark-ordered notifications."""
    bridge, esid = await _ensure_bridge(sid)
    q = bridge.subscribe()

    async def gen():
        watermark = 0
        try:
            state = (await bridge.read_session(esid)).get("state", {})
            watermark = state.get("eventId", bridge.last_event_id)
            try:
                state["stats"] = (await bridge.read_stats(esid)).get("stats")
            except BridgeError:
                state["stats"] = None
            # shortcut: Vibe 2.26 has no events/read replay; a snapshot repairs reconnects.
            yield _sse({"kind": "snapshot", **state, "lastEventId": watermark})
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if msg is None:
                    yield _sse({"kind": "error", "error": "Session stream closed; reconnecting"})
                    break
                event_id = (msg.get("params") or {}).get("eventId")
                if isinstance(event_id, int):
                    if event_id <= watermark:
                        continue
                    watermark = event_id
                event = normalize_notification(msg)
                if event_id is not None:
                    event["lastEventId"] = event_id
                yield _sse(event)
        except BridgeError as e:
            yield _sse({"kind": "error", "error": e.message})
        except asyncio.CancelledError:
            pass
        finally:
            bridge.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, default=str)}\n\n"


# ---- stats / runtime / skills / mcp / tools / agents

@app.get("/api/sessions/{sid}/stats")
async def get_stats(sid: str) -> dict:
    return {"session": store.get_costs(sid), "total": store.total_costs()}


@app.get("/api/sessions/{sid}/runtime")
async def get_runtime(sid: str) -> dict:
    bridge, esid = await _ensure_bridge(sid)
    try:
        return {"runtime": await bridge.read_runtime(esid)}
    except BridgeError as e:
        raise HTTPException(502, e.message)


class SharedSkillsSetting(BaseModel):
    enabled: StrictBool


@app.put("/api/skills/shared")
async def set_shared_skills(setting: SharedSkillsSetting) -> dict:
    try:
        path = provider_config.vibe_config_path()
        original, document = provider_config._document(path)
        document["experimental_enable_registry_skills"] = setting.enabled
        provider_config._write_document(path, original, document)
    except (ValueError, OSError):
        raise HTTPException(400, "Could not save shared skills. Check your Vibe configuration and try again.") from None
    return {"enabled": setting.enabled}


@app.get("/api/skills")
async def get_skills(sid: Optional[str] = Query(None)) -> dict:
    # filesystem skills (always available)
    skills_dir = Path(os.environ.get("VIBE_HOME", Path.home() / ".vibe")) / "skills"
    fs_skills = []
    if skills_dir.exists():
        for p in sorted(skills_dir.glob("*/SKILL.md")):
            fs_skills.append({"name": p.parent.name, "path": str(p), "size": p.stat().st_size})
    try:
        _, document = provider_config._document(provider_config.vibe_config_path())
    except (ValueError, OSError):
        raise HTTPException(400, "Vibe configuration could not be read") from None
    out = {"skills": fs_skills, "dir": str(skills_dir), "sharedEnabled": document.get("experimental_enable_registry_skills", False) is True}
    if sid:
        bridge, esid = await _ensure_bridge(sid)
        try:
            out["installed"] = await bridge.list_installed_skills(esid)
        except BridgeError:
            out["installed"] = None
    return out


class SkillImportItem(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    overwrite: StrictBool = False


class SkillImportRequest(BaseModel):
    items: list[SkillImportItem] = Field(min_length=1, max_length=500)
    projects: list[str] = Field(default_factory=list, max_length=100)
    paths: list[str] = Field(default_factory=list, max_length=20)


@app.get("/api/skills/importable")
async def get_importable_skills(project: list[str] = Query([]), path: list[str] = Query([])) -> dict:
    """Skills installed for other agents (Claude Code, Codex, project folders, chosen paths)."""
    try:
        sources = await asyncio.to_thread(skill_import.scan, project, path)
    except skill_import.SkillImportError as e:
        raise HTTPException(400, str(e)) from None
    return skill_import.serialize(sources)


@app.post("/api/skills/import/upload")
async def upload_skill(request: Request, filename: str = Query("SKILL.md", max_length=255)) -> dict:
    """Unpack an uploaded SKILL.md or zip into a staging folder and list what it holds."""
    if int(request.headers.get("content-length") or 0) > skill_import.MAX_BYTES:
        raise HTTPException(413, "File is larger than 25 MB")
    data = await request.body()
    if not data:
        raise HTTPException(400, "The file is empty")
    try:
        staged = await asyncio.to_thread(skill_import.stage_upload, data, filename, DATA_DIR / "skill-uploads")
        sources = await asyncio.to_thread(skill_import.scan, [], [str(staged)])
    except skill_import.SkillImportError as e:
        raise HTTPException(400, str(e)) from None
    out = skill_import.serialize([source for source in sources if source.root == staged])
    out["path"] = str(staged)
    return out


@app.post("/api/skills/import")
async def import_skills(body: SkillImportRequest) -> dict:
    """Copy the chosen skills into $VIBE_HOME/skills; existing ones only with overwrite."""
    try:
        result = await asyncio.to_thread(skill_import.import_selected,
                                         [(item.id, item.overwrite) for item in body.items],
                                         body.projects, body.paths)
    except skill_import.SkillImportError as e:
        raise HTTPException(400, str(e)) from None
    if result["imported"]:
        store.audit("skills.import", ", ".join(item["name"] for item in result["imported"]))
    return result


@app.get("/api/workspace/{kind}")
async def get_workspace(kind: Literal["connectors", "libraries"]) -> dict:
    from workspace import read_workspace
    return await read_workspace(kind, _require_key())


@app.post("/api/workspace/libraries", status_code=201)
async def create_workspace_library(req: LibraryCreate) -> dict:
    from workspace import create_library
    return await create_library(req.name, req.description, _require_key())


@app.get("/api/mcp")
async def get_mcp(sid: Optional[str] = Query(None)) -> dict:
    servers = []
    cfg = Path(os.environ.get("VIBE_HOME", Path.home() / ".vibe")) / "config.toml"
    if cfg.exists():
        try:
            raw = tomllib.loads(cfg.read_text())
            entries = raw.get("mcp_servers", raw.get("mcpServers", []))
            if isinstance(entries, dict):
                entries = [{"name": name, **item} for name, item in entries.items() if isinstance(item, dict)]
            # Never return environment secrets or authentication headers.
            servers = [{k: item[k] for k in ("name", "command", "transport", "url") if k in item}
                       for item in entries if isinstance(item, dict)]
        except (ValueError, OSError):
            raise HTTPException(400, "Vibe MCP configuration could not be parsed") from None
    out = {"servers": servers}
    if sid:
        bridge, esid = await _ensure_bridge(sid)
        try:
            out["live"] = await bridge.read_mcp(esid)
        except BridgeError:
            out["live"] = None
    return out


@app.get("/api/agents/settings")
async def get_agent_settings() -> dict:
    try:
        return read_agent_settings().model_dump()
    except ValueError as exc:
        if isinstance(exc.__cause__, OSError):
            raise HTTPException(409, str(exc)) from exc
        return JSONResponse({"detail": str(exc), "code": "invalid_agent_settings"}, status_code=409)


@app.put("/api/agents/settings")
async def put_agent_settings(settings: AgentSettings) -> dict:
    try:
        provider_config.sync_subagents(settings=settings)
        write_agent_settings(settings)
    except (ValueError, OSError) as exc:
        raise HTTPException(409, "Could not save subagents. Check VIBE_HOME and file permissions.") from exc
    store.audit("agents.settings", settings.policy)
    _stale_agent_policy.intersection_update(manager.all())
    _stale_agent_policy.update(sid for sid in manager.all() if sid != LISTER_KEY)
    return settings.model_dump()


@app.get("/api/agents")
async def get_agents(refresh: bool = Query(False)) -> dict:
    """Agent profiles known to the vibe CLI: built-in modes + custom profiles.

    Live profile data (display name, description, safety, agent type) comes
    from the app-server's own registry; the file path comes from the agents
    dir. Subagent-type profiles (fleet workers) are included — sessions may
    run as them, and the model may spawn them mid-turn.
    """
    agents_dir = Path(os.environ.get("VIBE_HOME") or Path.home() / ".vibe") / "agents"
    paths = {}
    if agents_dir.exists():
        for p in sorted(agents_dir.glob("*.toml")):
            paths[p.stem] = str(p)
    live = await _read_agents(refresh=refresh)
    if live:
        agents = []
        for a in live:
            agents.append({
                "name": a["name"],
                "displayName": a["displayName"],
                "description": a["description"],
                "safety": a["safety"],
                "agentType": a["agentType"],
                "path": paths.get(a["name"]),
            })
    else:
        # app-server unavailable: fall back to the files on disk
        agents = [{"name": n, "displayName": n, "description": "",
                   "safety": "", "agentType": "subagent", "path": p}
                  for n, p in paths.items()]
    return {"agents": agents, "dir": str(agents_dir)}


@app.get("/api/worktrees")
async def get_worktrees(sid: str = Query(...)) -> dict:
    bridge, _ = await _ensure_bridge(sid)
    try:
        return await bridge.list_worktrees()
    except BridgeError as e:
        raise HTTPException(502, e.message)


# ---- projects (working-directory candidates for the composer's project chip)

# Top-level home directories offered as quick-pick "projects" when they exist.
_KNOWN_PROJECT_DIRS = (
    "Documents", "Projects", "Code", "Development", "dev", "src",
    "git", "work", "workspace", "repos", "code",
)


@app.get("/api/projects")
async def get_projects() -> dict:
    """Working-directory candidates: recent session dirs + known project dirs.

    "Recent" comes from the session registry (distinct cwds, newest first,
    existing dirs only); "known" is a fixed set of conventional project
    locations under the home directory that actually exist.
    """
    home = Path.home()
    recent: list[dict] = []
    seen: set[str] = set()
    for row in store.list_sessions():
        cwd = (row.get("cwd") or "").strip()
        if not cwd or cwd in seen or not Path(cwd).is_dir():
            continue
        seen.add(cwd)
        recent.append({"path": cwd, "name": Path(cwd).name or cwd,
                       "lastUsed": row.get("updated_at") or 0})
    recent.sort(key=lambda r: r["lastUsed"], reverse=True)
    known = []
    for d in _KNOWN_PROJECT_DIRS:
        p = home / d
        if p.is_dir() and str(p) not in seen:
            known.append({"path": str(p), "name": p.name})
    for r in recent:
        r["branch"] = git_projects.head_branch(Path(r["path"]))
    return {
        "home": str(home),
        "recent": recent[:10],
        "known": known,
        "repos": await _discover_repos(home, [r["path"] for r in recent]),
    }


# Git repositories under home and next to recent projects. The walk is
# time-boxed and cached briefly; branches are re-read on every request.
_repo_cache: tuple[float, tuple, list[dict]] | None = None


def _vibe_trusted_folders() -> list[str]:
    """Folders the Vibe CLI was trusted in — where the user actually codes."""
    try:
        path = provider_config.vibe_config_path().parent / "trusted_folders.toml"
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [p for p in data.get("trusted", []) if isinstance(p, str)]


async def _discover_repos(home: Path, recent: list[str]) -> list[dict]:
    global _repo_cache
    roots: list[tuple[Path, int]] = [(home, 3)]
    for path in [*recent, *_vibe_trusted_folders()]:
        # siblings and cousins of places the user worked in (e.g. /mnt/disk/Projects/*)
        for ancestor in list(Path(path).parents)[:2]:
            if ancestor != home and home not in ancestor.parents and len(ancestor.parts) > 2 and ancestor.is_dir():
                roots.append((ancestor, 2))
    key = tuple(str(r) for r, _ in roots)
    if _repo_cache and _repo_cache[1] == key and time.monotonic() - _repo_cache[0] < 120:
        repos = _repo_cache[2]
    else:
        repos = await asyncio.to_thread(git_projects.find_repos, roots)
        _repo_cache = (time.monotonic(), key, repos)
    return [{**r, "branch": git_projects.head_branch(Path(r["path"])) or r["branch"]} for r in repos]


class GitSwitchReq(BaseModel):
    path: str
    branch: str
    create: StrictBool = False


@app.get("/api/git/branches")
async def git_branches(path: str = Query(..., min_length=1)) -> dict:
    target = Path(path).expanduser()
    if not target.is_absolute() or not target.is_dir():
        raise HTTPException(400, "path must be an existing absolute directory")
    info = await asyncio.to_thread(git_projects.branches, target)
    if info is None:
        raise HTTPException(404, "not a git repository")
    return info


@app.post("/api/git/switch")
async def git_switch(r: GitSwitchReq) -> dict:
    target = Path(r.path).expanduser()
    if not target.is_absolute() or not target.is_dir():
        raise HTTPException(400, "path must be an existing absolute directory")
    try:
        return await asyncio.to_thread(git_projects.switch, target, r.branch, r.create)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))


# ---- direct API chat (Chat lane)

@app.post("/api/chat")
async def chat(r: ChatReq):
    key = _require_key()
    messages: list[dict] = []
    if r.system_prompt:
        messages.append({"role": "system", "content": r.system_prompt})
    for message in r.messages:
        if message.get("role") not in ("user", "assistant") or not isinstance(message.get("content"), str):
            raise HTTPException(400, "invalid conversation message")
        messages.append({"role": message["role"], "content": message["content"]})
    # build user content (text + vision parts + text attachments)
    text = r.message
    image_parts = []
    for a in r.attachments or []:
        if a.get("dataUrl") and str(a.get("mime", "")).startswith("image/"):
            image_parts.append({"type": "image_url", "image_url": {"url": a["dataUrl"]}})
        elif a.get("text"):
            text += f"\n\n--- attached: {a.get('name')} ---\n{a['text']}"
    content: Any = [{"type": "text", "text": text}, *image_parts] if image_parts else text
    messages.append({"role": "user", "content": content})

    request_id = uuid.uuid4().hex
    async def gen():
        try:
            async for chunk in chat_stream(key, r.model, messages, r.reasoning_effort,
                                           r.temperature, r.max_tokens,
                                           lambda usage: store.record_api_usage(request_id, r.model, usage),
                                           generation=r.model_dump(exclude_none=True, include={"top_p", "random_seed", "presence_penalty", "frequency_penalty", "stop", "json_mode", "safe_prompt"})):
                yield chunk
        except Exception as e:  # noqa: BLE001
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---- Studio

@app.get("/api/studio/models")
async def studio_models() -> dict:
    key = _require_key()
    try:
        return {"models": await list_models(key)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e))


@app.post("/api/studio/completions")
async def studio_completion(r: CompletionReq) -> dict:
    key = _require_key()
    try:
        result = await completion(key, r.model, r.messages, r.temperature,
                                  r.max_tokens, r.reasoning_effort,
                                  generation=r.model_dump(exclude_none=True, include={"top_p", "random_seed", "presence_penalty", "frequency_penalty", "stop", "json_mode", "safe_prompt"}))
        if result.get("usage"):
            store.record_api_usage(uuid.uuid4().hex, r.model, result["usage"])
        return result
    except HTTPException:
        raise
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, e.response.text[:300])
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, str(e))


@app.get("/api/studio/usage")
async def studio_usage() -> dict:
    return await get_usage("")


@app.get("/api/studio/account")
async def studio_account(sid: Optional[str] = Query(None)) -> dict:
    out: dict[str, Any] = {"api_key_present": bool(resolve_api_key())}
    if sid:
        bridge, esid = await _ensure_bridge(sid)
        try:
            out["account"] = await bridge.read_account(esid)
        except BridgeError as e:
            out["error"] = e.message
    return out


# ---- Vibe Code Web: continue a session in the cloud (teleport)

_teleports = cloud_teleport.TeleportRegistry()


class CloudOpenReq(BaseModel):
    prompt: Optional[str] = Field(None, max_length=20000)


class CloudPickerReq(BaseModel):
    picker_id: str = Field(..., alias="pickerId", min_length=1, max_length=200)
    model_config = ConfigDict(populate_by_name=True)


class CloudSelectReq(CloudPickerReq):
    project_id: str = Field(..., alias="projectId", min_length=1, max_length=200)


class CloudCreateReq(CloudPickerReq):
    name: str = Field(..., min_length=1, max_length=200)
    default_branch: str = Field(..., alias="defaultBranch", min_length=1, max_length=200)


class CloudTeleportReq(CloudSelectReq):
    prompt: Optional[str] = Field(None, max_length=20000)


class CloudPushReq(BaseModel):
    approved: StrictBool


async def _cloud_call(sid: str, method: str, params: dict, timeout: float = 90.0) -> tuple[Any, str, Any]:
    bridge, esid = await _ensure_bridge(sid)
    try:
        return bridge, esid, await bridge.call(method, {"sessionId": esid, **params}, timeout=timeout)
    except BridgeError as e:
        raise HTTPException(409, e.message) from e


@app.post("/api/sessions/{sid}/cloud/open")
async def cloud_open(sid: str, r: CloudOpenReq) -> dict:
    """Open the Vibe Code project picker for this session's git repository."""
    params: dict[str, Any] = {"purpose": "teleport"}
    if r.prompt:
        params["prompt"] = r.prompt
    return (await _cloud_call(sid, "vibeCode/projects/open", params))[2]


@app.post("/api/sessions/{sid}/cloud/projects/more")
async def cloud_more(sid: str, r: CloudPickerReq) -> dict:
    return (await _cloud_call(sid, "vibeCode/projects/loadMore", {"pickerId": r.picker_id}))[2]


@app.post("/api/sessions/{sid}/cloud/projects/select")
async def cloud_select(sid: str, r: CloudSelectReq) -> dict:
    return (await _cloud_call(sid, "vibeCode/projects/select",
                              {"pickerId": r.picker_id, "projectId": r.project_id}))[2]


@app.post("/api/sessions/{sid}/cloud/projects/create")
async def cloud_create(sid: str, r: CloudCreateReq) -> dict:
    """Create a Vibe Code project for the repository and select it."""
    _, _, created = await _cloud_call(sid, "vibeCode/projects/create", {
        "pickerId": r.picker_id, "name": r.name, "defaultBranch": r.default_branch})
    project_id = ((created or {}).get("project") or {}).get("projectId")
    if not project_id:
        return created
    return (await _cloud_call(sid, "vibeCode/projects/select",
                              {"pickerId": r.picker_id, "projectId": project_id}))[2]


@app.post("/api/sessions/{sid}/cloud/cancel")
async def cloud_cancel(sid: str, r: CloudPickerReq) -> dict:
    await _cloud_call(sid, "vibeCode/projects/cancel", {"pickerId": r.picker_id})
    return {"ok": True}


@app.post("/api/sessions/{sid}/cloud/teleport")
async def cloud_teleport_start(sid: str, r: CloudTeleportReq) -> dict:
    bridge, esid = await _ensure_bridge(sid)
    try:
        op = await _teleports.start(bridge, sid, esid, r.picker_id, r.project_id, r.prompt)
    except BridgeError as e:
        raise HTTPException(409, e.message) from e
    store.audit("cloud.teleport", f"{sid} -> {r.project_id}")
    return op.view()


def _teleport_op(sid: str, op_id: str) -> cloud_teleport.TeleportOperation:
    op = _teleports.get(sid, op_id)
    if op is None:
        raise HTTPException(404, "teleport operation not found")
    return op


@app.get("/api/sessions/{sid}/cloud/teleport/{op_id}")
async def cloud_teleport_status(sid: str, op_id: str) -> dict:
    return _teleport_op(sid, op_id).view()


@app.post("/api/sessions/{sid}/cloud/teleport/{op_id}/push")
async def cloud_teleport_push(sid: str, op_id: str, r: CloudPushReq) -> dict:
    op = _teleport_op(sid, op_id)
    if op.push is None:
        raise HTTPException(409, "Teleport is not waiting for push approval")
    await _cloud_call(sid, "vibeCode/teleport/push/respond", {"operationId": op.id, "approved": r.approved})
    return op.view()


@app.post("/api/sessions/{sid}/cloud/teleport/{op_id}/cancel")
async def cloud_teleport_cancel(sid: str, op_id: str) -> dict:
    op = _teleport_op(sid, op_id)
    bridge, esid = await _ensure_bridge(sid)
    try:
        await _teleports.cancel(bridge, esid, op)
    except BridgeError as e:
        raise HTTPException(409, e.message) from e
    return op.view()


@app.get("/api/studio/costs")
async def studio_costs() -> dict:
    rows = store.list_sessions_with_costs()
    return {"total": store.total_costs(),
            "sessions": [{"id": r["id"], "costs": r["costs"]} for r in rows]}


@app.get("/api/usage")
async def usage_snapshot(year: Optional[int] = None, month: Optional[int] = None,
                         refresh: bool = False) -> dict:
    now = datetime.now(timezone.utc)
    year, month = now.year if year is None else year, now.month if month is None else month
    if not 2000 <= year <= now.year or not 1 <= month <= 12:
        raise HTTPException(400, "invalid billing month")
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    end = datetime(year + (month == 12), month % 12 + 1, 1, tzinfo=timezone.utc)
    result = await usage_reader.read(year, month, refresh)
    return {**result, "period": {"year": year, "month": month},
            "local": store.usage_activity(start.timestamp(), end.timestamp())}


# ---- audit

@app.get("/api/audit")
async def audit() -> dict:
    return {"audit": store.list_audit(100)}


# Unknown /api/* paths must 404 as JSON — never fall through to the SPA
# catch-all below and return index.html with a 200.
@app.api_route("/api/{full_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
               include_in_schema=False)
async def api_not_found(full_path: str):
    raise HTTPException(404, f"unknown API route: /api/{full_path}")


# ---- static frontend

_HERE = Path(__file__).resolve().parent
# Find the built frontend (a dir containing index.html) across repo + installed layouts.
_DIST_CANDIDATES = [
    _HERE.parent / "frontend" / "dist",   # repo layout: <repo>/frontend/dist
    _HERE.parent / "frontend",             # installed: <app>/frontend
    _HERE.parent / "dist",                 # installed: <app>/dist
    _HERE / "dist",                        # installed: <app>/sidecar/dist
]
_DIST = next((p for p in _DIST_CANDIDATES if (p / "index.html").is_file()), None)

# Never let the browser pin a stale SPA: index.html must always be revalidated so a
# rebuilt frontend (new hashed assets) is picked up immediately.
_NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"}

if _DIST is not None:
    from fastapi.staticfiles import StaticFiles
    if (_DIST / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        dist_root = str(_DIST.resolve())
        candidate = (_DIST / full_path).resolve()
        # path-boundary check (with trailing sep) so e.g. /dist2 can't pass for /dist
        if full_path and candidate.is_file() and str(candidate).startswith(dist_root + os.sep):
            return FileResponse(candidate, headers=_NO_CACHE)
        return FileResponse(_DIST / "index.html", headers=_NO_CACHE)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
