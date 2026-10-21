"""VibeDeck bridge to the Mistral Vibe app-server.

Spawns ``vibe-app-server`` (the JSON-RPC server that ships with the Vibe CLI and
powers Vibe Code Web) as a subprocess and speaks its wire protocol over stdio.

Wire contract (verified against vibe 2.26.0 and 3.0.1):
  * JSON-RPC 2.0, one message per line, on stdin/stdout. stderr is logs.
  * Field names are camelCase on the wire (pydantic ``to_camel`` alias generator,
    ``extra="forbid"``). Send exact camelCase keys.
  * Handshake: ``initialize`` request, then an ``initialized`` *notification*
    (``{"jsonrpc":"2.0","method":"initialized","params":{}}``). Only after that
    are other methods accepted.
  * The server is cwd-locked: it must be spawned with ``cwd`` set to the working
    directory the session should run in. One app-server process hosts one
    attached session at a time.
  * Real-time events are pushed as JSON-RPC *notifications* (``history/entryAdded``,
    ``history/entryUpdated`` with JSON-patch deltas, ``turn/started``,
    ``turn/completed``, ``session/statsUpdated``, ``runtime/updated`` ...).
    ``events/read`` is the watermark-based catch-up channel.
  * Approvals arrive as ``callback`` history entries; answer them with
    ``callback/result``.

OPSEC: binds to nothing (stdio only); the only outbound network is whatever the
vibe CLI itself does. No secrets are logged.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from pathlib import Path
from typing import Any, Optional

# Default model for vibecoding / general use. mistral-large-4 is Mistral's current
# flagship: largest context window (512k), vision, function calling, top reasoning.
DEFAULT_MODEL = "mistral-large-4"
DEFAULT_AGENT = "accept-edits"

# Desktop agent modes; Plan is installed as a read-only profile on Vibe 3.
AGENT_MODES = ("ask", "plan", "accept-edits", "auto-approve")

# Reasoning / thinking levels accepted by config/model/write.
REASONING_LEVELS = ("off", "low", "medium", "high", "max")

# Approval decision types (ApprovalDecisionType StrEnum, lowercased names).
APPROVAL_DECISIONS = ("approve", "approve_for_session", "approve_permanently", "deny", "cancel_turn")


def find_app_server() -> str:
    """Locate the ``vibe-app-server`` executable."""
    env = os.environ.get("VIBEDECK_APP_SERVER")
    if env:
        return env
    # uv tool install puts it here.
    home = Path.home()
    candidates = [
        home / ".local/bin/vibe-app-server",
        home / ".local/share/uv/tools/mistral-vibe/bin/vibe-app-server",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    found = shutil.which("vibe-app-server")
    if found:
        return found
    raise FileNotFoundError(
        "vibe-app-server not found. Install the Vibe CLI: uv tool install mistral-vibe"
    )


class BridgeError(RuntimeError):
    def __init__(self, code: Any, message: str, data: Any = None):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.data = data


class VibeAppServer:
    """Async JSON-RPC client for one ``vibe-app-server`` subprocess.

    One instance == one working directory == one attached vibe session.
    """

    def __init__(self, cwd: str, server_cmd: Optional[str] = None,
                 stderr_log: Optional[Path] = None):
        self.cwd = str(Path(cwd).resolve())
        self.server_cmd = server_cmd or find_app_server()
        self.stderr_log = stderr_log
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._drain_task: Optional[asyncio.Task] = None
        self._stderr_file = None
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._subscribers: list[asyncio.Queue] = []
        self._tap_queues: list[asyncio.Queue] = []
        self._lock = asyncio.Lock()
        self._closed = False
        self.server_version: Optional[str] = None
        # session_id of the currently attached session (set by start/resume)
        self.session_id: Optional[str] = None
        # last event watermark seen (for catch-up)
        self.last_event_id: int = 0
        # last time an RPC was sent or a UI subscriber attached (idle reaping)
        self.last_activity: float = time.time()

    @property
    def alive(self) -> bool:
        """True while the app-server process is running and the bridge is open."""
        return (not self._closed and self._proc is not None
                and self._proc.returncode is None)

    @property
    def has_ui_subscribers(self) -> bool:
        """True when a live consumer (SSE stream) is attached — not just taps."""
        return any(q not in self._tap_queues for q in self._subscribers)

    # ------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        stderr = asyncio.subprocess.PIPE
        if self.stderr_log is not None:
            self._stderr_file = open(self.stderr_log, "ab", buffering=0)
            stderr = self._stderr_file
        # The app-server resolves its API key from the environment first and
        # the keyring second. A placeholder or malformed MISTRAL_API_KEY in
        # our own environment (e.g. the shipped "YOUR_KEY" template in the
        # vibedeck env file, which the launcher sources) would shadow the real
        # keyring key and fail every turn — strip anything that isn't a
        # plausible key so the app-server falls back to the keyring.
        env = dict(os.environ)
        _key = env.get("MISTRAL_API_KEY")
        if _key is not None and (len(_key) <= 10 or _key == "YOUR_KEY"):
            del env["MISTRAL_API_KEY"]
        # NOTE: app-server responses/notifications (runtime config, full history
        # snapshots) are single JSON lines that can exceed 64 KB. asyncio's default
        # stream limit would raise LimitOverrunError and kill the reader, so raise it.
        self._proc = await asyncio.create_subprocess_exec(
            self.server_cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr,
            cwd=self.cwd,
            env=env,
            limit=64 * 1024 * 1024,  # 64 MB line limit
        )
        self._reader_task = asyncio.create_task(self._read_loop())
        # handshake. capabilities.callbackKinds is REQUIRED: without it the server
        # raises "Client does not support approval callbacks" and kills the process
        # when an approval is requested.
        init = await self.call("initialize", {
            "clientInfo": {"name": "vibedeck", "version": "1.0.0"},
            "capabilities": {"callbackKinds": ["approval", "user_input"]},
        })
        self.server_version = (init.get("serverInfo") or {}).get("version")
        self._send_raw({"jsonrpc": "2.0", "method": "initialized", "params": {}})

    async def close(self) -> None:
        self._closed = True
        # fail any pending requests
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(BridgeError("closed", "bridge closed"))
        self._pending.clear()
        # wake every subscriber so SSE streams and taps end instead of hanging
        # on queue.get() forever
        for q in list(self._subscribers):
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                q.get_nowait()
                q.put_nowait(None)
        if self._drain_task is not None:
            self._drain_task.cancel()
            self._drain_task = None
        if self._proc is not None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except Exception:
                try:
                    self._proc.kill()
                    await self._proc.wait()
                except Exception:
                    pass
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass  # expected: we just cancelled it (BaseException, not Exception)
            except Exception:
                pass
        if self._stderr_file is not None:
            try:
                self._stderr_file.close()
            except Exception:
                pass
            self._stderr_file = None

    # ------------------------------------------------------------ transport

    def _send_raw(self, msg: dict) -> None:
        if self._proc is None or self._proc.stdin is None:
            raise BridgeError("closed", "process not running")
        data = (json.dumps(msg, separators=(",", ":")) + "\n").encode()
        self._proc.stdin.write(data)
        # drain is async; keep one tracked task so writes get flushed without
        # piling up untracked tasks (an in-flight drain covers later writes)
        if self._drain_task is None or self._drain_task.done():
            try:
                self._drain_task = asyncio.get_running_loop().create_task(self._drain_stdin())
            except RuntimeError:
                pass

    async def _drain_stdin(self) -> None:
        try:
            if self._proc is not None and self._proc.stdin is not None:
                await self._proc.stdin.drain()
        except Exception:
            pass  # broken pipe: the reader loop notices the dead process

    async def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while True:
                try:
                    line = await self._proc.stdout.readline()
                except Exception:
                    break  # process closed / stream error
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue  # never let a stray log line kill the stream
                if "id" in msg and ("result" in msg or "error" in msg):
                    # response to one of our requests
                    fut = self._pending.pop(msg["id"], None)
                    if fut is not None and not fut.done():
                        if "error" in msg:
                            e = msg["error"]
                            fut.set_exception(BridgeError(e.get("code"), e.get("message", ""), e.get("data")))
                        else:
                            fut.set_result(msg.get("result"))
                elif "id" in msg and "method" in msg:
                    # server -> client REQUEST (e.g. callback/call). Acknowledge it and
                    # fan the payload out to subscribers so the UI can act on it.
                    self._handle_server_request(msg)
                elif "method" in msg:
                    # notification -> fan out to subscribers
                    self._track_watermark(msg)
                    for q in list(self._subscribers):
                        try:
                            q.put_nowait(msg)
                        except asyncio.QueueFull:
                            # End this stream; its reconnect takes a fresh snapshot.
                            q.get_nowait()
                            q.put_nowait(None)
        finally:
            # the process exited or the stream broke: fail pending requests and
            # wake subscribers so nothing hangs on a dead bridge
            self._closed = True
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(BridgeError("process_exited", "app-server exited"))
            self._pending.clear()
            for q in list(self._subscribers):
                try:
                    q.put_nowait(None)
                except asyncio.QueueFull:
                    q.get_nowait()
                    q.put_nowait(None)

    def _handle_server_request(self, msg: dict) -> None:
        method = msg.get("method")
        rid = msg.get("id")
        params = msg.get("params") or {}
        if method == "callback/call":
            callback = params.get("callback") or {}
            cbid = callback.get("callbackId") or callback.get("callback_id") or ""
            # acknowledge so the server keeps the callback open for callback/result
            self._send_raw({"jsonrpc": "2.0", "id": rid,
                            "result": {"callbackId": cbid, "accepted": True}})
            # surface to subscribers as an actionable event
            evt = {"method": "callback/requested", "params": {"callback": callback}}
            self._track_watermark(evt)
            for q in list(self._subscribers):
                try:
                    q.put_nowait(evt)
                except asyncio.QueueFull:
                    q.get_nowait()
                    q.put_nowait(None)
        else:
            # unknown server request: respond with method-not-found so it doesn't hang
            self._send_raw({"jsonrpc": "2.0", "id": rid,
                            "error": {"code": -32601, "message": f"unsupported server request {method}"}})

    def _track_watermark(self, msg: dict) -> None:
        p = msg.get("params") or {}
        eid = p.get("eventId")
        if isinstance(eid, int) and eid > self.last_event_id:
            self.last_event_id = eid

    # ------------------------------------------------------------ rpc

    async def call(self, method: str, params: Optional[dict] = None,
                   timeout: float = 60.0) -> Any:
        if self._closed:
            raise BridgeError("closed", "bridge closed")
        self.last_activity = time.time()
        async with self._lock:
            self._id += 1
            rid = self._id
        req: dict[str, Any] = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            req["params"] = params
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            self._send_raw(req)
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            raise BridgeError("timeout", f"{method} timed out after {timeout}s") from None
        finally:
            self._pending.pop(rid, None)

    def subscribe(self, maxsize: int = 1000, tap: bool = False) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._subscribers.append(q)
        if tap:
            self._tap_queues.append(q)
        else:
            self.last_activity = time.time()
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)
        if q in self._tap_queues:
            self._tap_queues.remove(q)

    # ------------------------------------------------------------ sessions

    async def start_session(self, history_limit: int = 200) -> dict:
        """Start a fresh vibe session in this server's cwd. Returns session state."""
        res = await self.call("session/start", {"historyLimit": history_limit})
        state = res.get("state", {})
        self.session_id = state.get("session", {}).get("id")
        self.last_event_id = state.get("eventId", 0)
        return state

    async def resume_session(self, session_id: str, history_limit: int = 200) -> dict:
        res = await self.call("session/resume", {
            "sessionId": session_id, "historyLimit": history_limit,
        })
        state = res.get("state", {})
        self.session_id = state.get("session", {}).get("id", session_id)
        self.last_event_id = state.get("eventId", 0)
        return state

    async def list_sessions(self, limit: int = 100) -> list[dict]:
        items = []
        cursor = None
        seen = set()
        while True:
            params = {"limit": min(limit, 500)}
            if cursor:
                params["cursor"] = cursor
            res = await self.call("session/list", params)
            page = res.get("items") if isinstance(res, dict) else None
            if (not isinstance(page, list) or any(not isinstance(item, dict)
                    or not isinstance(item.get("id"), str) or not item["id"] for item in page)):
                raise BridgeError("invalid_listing", "Session listing was incomplete or malformed.")
            items.extend(page)
            cursor = res.get("nextCursor")
            if cursor is None or cursor == "":
                return items
            if not isinstance(cursor, str) or cursor in seen:
                raise BridgeError("invalid_listing", "Session listing cursor did not advance.")
            seen.add(cursor)

    async def read_session(self, session_id: str, before: Optional[str] = None) -> dict:
        history = {"limit": 200, "direction": "backward"}
        if before:
            history["cursor"] = before
        return await self.call("session/read", {
            "sessionId": session_id, "history": history,
            "turns": {"limit": 50, "direction": "backward"},
        })

    async def stop_session(self, session_id: str, reason: Optional[str] = None) -> dict:
        return await self.call("session/stop", {"sessionId": session_id, "reason": reason})

    async def delete_session(self, session_id: str) -> dict:
        return await self.call("session/delete", {"sessionId": session_id})

    async def rename_session(self, session_id: str, title: str) -> dict:
        return await self.call("session/title/update", {"sessionId": session_id, "title": title})

    # ------------------------------------------------------------ config

    async def set_model(self, session_id: str, model: str,
                        reasoning_effort: Optional[str] = None) -> dict:
        params: dict[str, Any] = {"sessionId": session_id, "modelAlias": model}
        if reasoning_effort:
            params["reasoningEffort"] = reasoning_effort
        result = await self.call("config/model/write", params)
        if result.get("rejected") or result.get("failures"):
            raise BridgeError("config_rejected", "Vibe rejected this model configuration", result)
        return result

    async def set_agent(self, session_id: str, agent_name: str) -> dict:
        return await self.call("session/agent/update", {
            "sessionId": session_id, "agentName": agent_name,
        })

    async def reload_config(self, session_id: str) -> dict:
        return await self.call("config/reload", {"sessionId": session_id, "reloadRuntime": True})

    async def read_runtime(self, session_id: str) -> dict:
        return await self.call("runtime/read", {"sessionId": session_id})

    async def read_config(self) -> dict:
        return await self.call("config/read", {})

    # ------------------------------------------------------------ turns

    async def send_turn(self, session_id: str, text: str,
                        images: Optional[list[dict]] = None,
                        request_id: Optional[str] = None) -> dict:
        message: list[dict] = [{"type": "text", "text": text}]
        for img in images or []:
            message.append({"type": "image", "attachment": img})
        res = await self.call("turn/start", {
            "sessionId": session_id, "message": message,
            "idempotencyKey": request_id,
        })
        if isinstance(res.get("lastEventId"), int):
            self.last_event_id = res["lastEventId"]
        return res

    async def interrupt_turn(self, session_id: str, turn_id: str) -> dict:
        return await self.call("turn/interrupt", {
            "sessionId": session_id, "expectedTurnId": turn_id,
        })

    async def steer_turn(self, session_id: str, turn_id: str, text: str) -> dict:
        return await self.call("turn/steer", {
            "sessionId": session_id, "expectedTurnId": turn_id,
            "message": [{"type": "text", "text": text}],
        })

    # ------------------------------------------------------------ events

    async def read_events(self, after_event_id: Optional[int] = None,
                          batch_size: int = 200,
                          session_ids: Optional[list[str]] = None) -> dict:
        params: dict[str, Any] = {"batchSize": batch_size}
        if after_event_id is not None:
            params["afterEventId"] = after_event_id
        if session_ids:
            params["filters"] = {"sessionIds": session_ids}
        res = await self.call("events/read", params)
        if isinstance(res.get("lastEventId"), int):
            self.last_event_id = res["lastEventId"]
        return res

    # ------------------------------------------------------------ approvals

    async def resolve_callback(self, session_id: str, callback_id: str,
                               decision: str = "approve",
                               feedback: Optional[str] = None,
                               user_input: Optional[dict] = None) -> dict:
        """Answer an approval (or user-input) callback."""
        if decision not in APPROVAL_DECISIONS:
            raise BridgeError("invalid_params", f"unknown decision {decision!r}")
        output: dict[str, Any] = {"type": "approval", "decision": {"type": decision}}
        if user_input is not None:
            output = {"type": "user_input", "result": user_input}
        elif feedback:
            output["feedback"] = feedback
        return await self.call("callback/result", {
            "sessionId": session_id,
            "result": {"callbackId": callback_id, "output": output},
        })

    # ------------------------------------------------------------ workspace / skills / mcp / tools

    async def trust_status(self) -> dict:
        return await self.call("workspace/trust/status", {})

    async def trust_decision(self, decision: str) -> dict:
        # decision: "trust_repo" | "trust_cwd" | "decline"
        return await self.call("workspace/trust/decision", {"decision": decision})

    async def list_worktrees(self, include_details: bool = False) -> dict:
        # wire params are cwd + includeDetails (verified against vibe 2.26.0:
        # WorkspaceWorktreeListParams requires cwd, min_length=1)
        return await self.call("workspace/git/worktrees/list", {
            "cwd": self.cwd, "includeDetails": include_details,
        })

    async def list_skills(self, session_id: str) -> dict:
        return await self.call("skills/list", {"sessionId": session_id})

    async def list_installed_skills(self, session_id: str) -> dict:
        return await self.call("skills/installed", {"sessionId": session_id})

    async def read_mcp(self, session_id: str) -> dict:
        return await self.call("mcp/read", {"sessionId": session_id})

    async def read_account(self, session_id: str) -> dict:
        return await self.call("account/read", {"sessionId": session_id})

    async def read_stats(self, session_id: str) -> dict:
        return await self.call("stats/read", {"sessionId": session_id})

    async def list_agents(self) -> dict:
        return await self.call("agents/list", {})

    async def read_session_log(self, session_id: str, limit: int = 200) -> dict:
        return await self.call("session/log/read", {"sessionId": session_id, "limit": limit})


class SessionManager:
    """Owns the set of live ``VibeAppServer`` bridges (one per active session)."""

    def __init__(self, log_dir: Optional[Path] = None):
        self._bridges: dict[str, VibeAppServer] = {}
        self.log_dir = log_dir
        from weakref import WeakValueDictionary
        self._open_locks = WeakValueDictionary()

    def get(self, session_id: str) -> Optional[VibeAppServer]:
        return self._bridges.get(session_id)

    def register(self, session_id: str, bridge: VibeAppServer) -> None:
        self._bridges[session_id] = bridge

    async def spawn(self, cwd: str, key: str = "pending") -> VibeAppServer:
        """Create + start a bridge for ``cwd`` without registering it yet.

        The caller registers it under the real session id once known (the id is
        assigned by the app-server on session/start).
        """
        log = None
        if self.log_dir is not None:
            self.log_dir.mkdir(parents=True, exist_ok=True)
            log = self.log_dir / f"appserver-{key}.log"
        bridge = VibeAppServer(cwd=cwd, stderr_log=log)
        try:
            await bridge.start()
        except BaseException:
            await bridge.close()
            raise
        return bridge

    async def open(self, session_id: str, cwd: str) -> VibeAppServer:
        """Return the live bridge for a session, spawning one if needed."""
        lock = self._open_locks.get(session_id)
        if lock is None:
            lock = asyncio.Lock()
            self._open_locks[session_id] = lock
        async with lock:
            bridge = self._bridges.get(session_id)
            if bridge is not None and bridge.alive:
                return bridge
            if bridge is not None:
                await self.close(session_id)
            bridge = await self.spawn(cwd, key=session_id)
            self._bridges[session_id] = bridge
            return bridge

    async def close(self, session_id: str) -> None:
        b = self._bridges.pop(session_id, None)
        if b is not None:
            await b.close()

    async def close_all(self) -> None:
        for sid in list(self._bridges):
            await self.close(sid)

    def all(self) -> dict[str, VibeAppServer]:
        return dict(self._bridges)
