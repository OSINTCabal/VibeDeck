"""Session-scoped vibe app-server calls for feature routers.

Feature modules (review, queue, worktrees, …) live in their own files with an
``APIRouter`` and call the session's app-server through :func:`session_call`.
The server registers how a VibeDeck session id maps to a running bridge with
:func:`configure` at import time, which keeps the routers free of a circular
import on ``vibedeck_server``.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable, Optional

from fastapi import HTTPException
from vibe_bridge import BridgeError

# transport failures, as opposed to the app-server refusing the request
TRANSPORT_ERRORS = ("timeout", "closed", "process_exited")

EnsureBridge = Callable[[str], Awaitable[tuple[Any, str]]]
_ensure_bridge: Optional[EnsureBridge] = None


def configure(ensure_bridge: EnsureBridge) -> None:
    global _ensure_bridge
    _ensure_bridge = ensure_bridge


async def session_call(sid: str, method: str, params: Optional[dict] = None,
                       timeout: float = 90.0) -> tuple[Any, str, Any]:
    """Call ``method`` for VibeDeck session ``sid``; returns ``(bridge, esid, result)``.

    ``sessionId`` is filled in with the vibe session id. A refusal by the
    app-server becomes HTTP 409 with its message, a lost connection 502.
    """
    if _ensure_bridge is None:
        raise RuntimeError("session_rpc.configure() was not called")
    bridge, esid = await _ensure_bridge(sid)
    try:
        return bridge, esid, await bridge.call(method, {"sessionId": esid, **(params or {})}, timeout=timeout)
    except BridgeError as e:
        raise HTTPException(502 if e.code in TRANSPORT_ERRORS else 409, e.message) from e
