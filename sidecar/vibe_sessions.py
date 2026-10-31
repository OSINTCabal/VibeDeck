"""Sync VibeDeck's session registry with the vibe CLI's session store.

The desktop app and the vibe CLI are two front-ends over the same session
store: both drive ``vibe-app-server``, which persists every session under
``~/.vibe/logs/session`` (legacy ``session_*/`` folders and the unified
``unified/`` journal store). This module lists that store through a dedicated
app-server bridge and mirrors it into VibeDeck's registry, so sessions started
in the CLI show up in the sidebar and can be continued in the desktop app —
and sessions started in the desktop app are equally continuable from the CLI.

Concurrency note: the app-server takes an exclusive lease on a session while
it is attached, so a session can only be written by one surface at a time.
External changes therefore only ever happen while no desktop bridge is alive
for that session, and the next open simply resumes from disk — no in-memory
reload logic is needed.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from pathlib import Path
from typing import Any, Optional

from vibe_bridge import BridgeError, SessionManager, VibeAppServer

# Reserved SessionManager key for the listing bridge (not a real session).
LISTER_KEY = "__vibe_list__"

LIST_LIMIT = 500   # the app-server rejects larger pages
REFRESH_TTL = 5.0  # min seconds between session/list calls
TITLE_MAX = 80


def _ms_to_s(value: Any) -> Optional[float]:
    """app-server timestamps are epoch milliseconds."""
    if isinstance(value, (int, float)) and value > 0:
        return value / 1000.0
    return None


def _title_from(item: dict) -> str:
    title = (item.get("title") or "").strip()
    if title:
        return title
    preview = " ".join((item.get("preview") or "").split())
    if preview:
        return preview[:TITLE_MAX] + ("…" if len(preview) > TITLE_MAX else "")
    return "Vibe session"


def _status_from(item: dict) -> str:
    status = item.get("status")
    if isinstance(status, dict) and status.get("type"):
        return str(status["type"])
    return "idle"


def _session_log_dir() -> Path:
    vibe_home = Path(os.environ.get("VIBE_HOME") or Path.home() / ".vibe")
    return vibe_home / "logs" / "session"


def cleanup_store_dir(session_id: str) -> None:
    """Remove leftover store shells after a successful app-server delete.

    The app-server's delete removes the session content, but for a session
    that was attached to the deleting bridge it can leave a directory shell
    behind (meta.json + scheduled-loops.json, no journal), and a legacy
    delete can leave the folder if the rmtree raced. Only ever called after
    a successful delete RPC — the session is already gone at that point.
    """
    root = _session_log_dir()
    # unified shell: directory exists but has no journal
    uni = root / "unified" / session_id
    try:
        if uni.is_dir() and not (uni / "journal").is_dir():
            shutil.rmtree(uni, ignore_errors=True)
    except OSError:
        pass
    # legacy folder: session_*_<short id> with a matching meta session_id
    try:
        for d in root.glob(f"session_*_{session_id[:8]}"):
            meta = d / "meta.json"
            if not meta.is_file():
                continue
            try:
                if json.loads(meta.read_text()).get("session_id") == session_id:
                    shutil.rmtree(d, ignore_errors=True)
            except (OSError, ValueError):
                continue
    except OSError:
        pass


class VibeSessionSync:
    """Lists the shared vibe session store and mirrors it into VibeDeck's DB."""

    def __init__(self, store, manager: SessionManager,
                 log_dir: Optional[Path] = None):
        self.store = store
        self.manager = manager
        self.log_dir = log_dir
        self._lock = asyncio.Lock()
        self._last_refresh = 0.0
        self._items: dict[str, dict] = {}
        self._fresh_listing = False
        # last title we saw in the store per session — lets us tell an
        # external (CLI-side) rename apart from a local one
        self._last_titles: dict[str, str] = {}

    # ------------------------------------------------------------ listing

    async def _lister(self) -> VibeAppServer:
        bridge = self.manager.get(LISTER_KEY)
        if bridge is not None and bridge.alive:
            return bridge
        if bridge is not None:
            await self.manager.close(LISTER_KEY)
        log = None
        if self.log_dir is not None:
            self.log_dir.mkdir(parents=True, exist_ok=True)
            log = self.log_dir / "appserver-vibe-list.log"
        bridge = VibeAppServer(cwd=str(Path.home()), stderr_log=log)
        await bridge.start()
        self.manager.register(LISTER_KEY, bridge)
        return bridge

    async def host(self) -> VibeAppServer:
        """An app-server bound to no session, for host-wide calls (worktrees)."""
        return await self._lister()

    async def refresh(self, force: bool = False) -> dict[str, dict]:
        """Re-list the shared store (throttled). Returns items keyed by id."""
        async with self._lock:
            self._fresh_listing = False
            if (not force and self._last_refresh
                    and time.time() - self._last_refresh < REFRESH_TTL):
                return self._items
            try:
                bridge = await self._lister()
                items = await bridge.list_sessions(limit=LIST_LIMIT)
                if (not isinstance(items, list) or any(not isinstance(it, dict)
                        or not isinstance(it.get("id"), str) or not it["id"] for it in items)):
                    raise BridgeError("invalid_listing", "Session listing was incomplete or malformed.")
            except (BridgeError, FileNotFoundError, OSError):
                # app-server unavailable: keep serving what we already have
                self._last_refresh = time.time()
                return self._items
            self._items = {
                it["id"]: it for it in items
                if isinstance(it, dict) and it.get("id")
            }
            self._last_refresh = time.time()
            self._fresh_listing = True
            return self._items

    def listed(self, sid: str) -> Optional[dict]:
        return self._items.get(sid)

    # ------------------------------------------------------------ import

    def _row_fields(self, sid: str, item: dict,
                    row: Optional[dict]) -> dict[str, Any]:
        """Fields to upsert for a listed session (row=None → fresh import)."""
        eff = item
        if row is not None and row.get("vibe_session_id"):
            # legacy session migrated to a unified id on resume: the migrated
            # session's listing carries the live title/activity
            eff = self._items.get(row["vibe_session_id"]) or item
        fields: dict[str, Any] = {}

        listed_title = _title_from(eff)
        if row is None:
            fields["title"] = listed_title
        elif row.get("origin") == "vibe":
            # CLI sessions: the store is the source of truth
            if listed_title != (row.get("title") or ""):
                fields["title"] = listed_title
        else:
            # VibeDeck sessions: adopt a title only when it changed in the
            # store since the last sync (an external rename), never clobber
            # a local one
            prev = self._last_titles.get(sid)
            if (prev is not None and listed_title != prev
                    and listed_title != (row.get("title") or "")):
                fields["title"] = listed_title
        self._last_titles[sid] = listed_title

        # activity timestamp — never move backwards
        listed_upd = _ms_to_s(eff.get("updatedAt"))
        row_upd = row.get("updated_at") if row is not None else None
        if listed_upd is not None and (row_upd is None or listed_upd > row_upd):
            fields["updated_at"] = listed_upd

        if row is None:
            agent = eff.get("agent")
            fields.update({
                "cwd": eff.get("cwd") or str(Path.home()),
                "agent": (agent.get("name") if isinstance(agent, dict) else agent),
                "model": eff.get("model"),
                "lane": "code",  # CLI sessions are agentic
                "status": _status_from(eff),
                "origin": "vibe",
                "created_at": _ms_to_s(eff.get("createdAt")) or time.time(),
            })
        else:
            if row.get("origin") == "vibe":
                if eff.get("cwd"):
                    fields["cwd"] = eff["cwd"]
                if eff.get("agent"):
                    agent = eff["agent"]
                    fields["agent"] = agent.get("name") if isinstance(agent, dict) else agent
                if eff.get("model"):
                    fields["model"] = eff["model"]
            # rows without a live bridge mirror the store's status (a session
            # running in the CLI shows as running here)
            status = _status_from(eff)
            if row.get("status") != status:
                fields["status"] = status
        return fields

    async def sync(self, live_sids: Optional[set] = None,
                   force: bool = False) -> dict[str, dict]:
        """Mirror the shared store into VibeDeck's registry.

        ``live_sids`` are sessions with a live desktop bridge — those rows are
        owned by the turn/tap machinery and are skipped (their store entries
        cannot change externally anyway: the bridge holds the session lease).
        """
        items = await self.refresh(force=force)
        live = live_sids if live_sids is not None else set()
        rows = {r["id"]: r for r in self.store.list_sessions()}
        if self._fresh_listing:
            for sid, row in list(rows.items()):
                native_ids = {sid, row.get("vibe_session_id")} - {None}
                if row.get("origin") == "vibe" and not native_ids.intersection(items) and not native_ids.intersection(live):
                    self.store.delete_session(sid)
                    self._last_titles.pop(sid, None)
                    del rows[sid]
            self._fresh_listing = False
        # unified sessions that are the migrated counterpart of a legacy row
        migrated = {
            r["vibe_session_id"] for r in rows.values()
            if r.get("vibe_session_id")
        }
        for sid, item in items.items():
            if sid in migrated:
                # represented by its legacy row — drop a stale duplicate row
                # (e.g. imported before the migration was observed), but never
                # one with a live bridge behind it
                dup = rows.get(sid)
                if dup is not None and sid not in live:
                    self.store.delete_session(sid)
                continue
            row = rows.get(sid)
            if row is not None and sid in live:
                continue
            try:
                fields = self._row_fields(sid, item, row)
                # upsert_session defaults these to "now" — preserve the row's
                # values when the listing has nothing newer to say
                if row is not None:
                    fields.setdefault("updated_at", row["updated_at"])
                    fields.setdefault("created_at", row["created_at"])
                if row is None or any(row.get(key) != value for key, value in fields.items()):
                    self.store.upsert_session(sid, **fields)
            except Exception:
                pass  # one bad row must not break the whole sync
        return items

    async def ensure_row(self, sid: str) -> Optional[dict]:
        """Import sid on demand (deep link / direct open). Returns the row."""
        row = self.store.get_session(sid)
        if row is not None:
            return row
        items = await self.refresh(force=True)
        item = items.get(sid)
        if item is None:
            # maybe it is a migrated counterpart id — resolve to its row
            for r in self.store.list_sessions():
                if r.get("vibe_session_id") == sid:
                    return r
            return None
        fields = self._row_fields(sid, item, None)
        self.store.upsert_session(sid, **fields)
        return self.store.get_session(sid)
