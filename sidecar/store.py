"""VibeDeck local persistence (SQLite).

VibeDeck's own metadata lives here: session registry (id, cwd, agent, model,
reasoning, status), default config, per-session cost tracking, and an audit log.
The conversation history itself stays in Vibe's own session store (served via the
app-server); this DB is the UI/control-plane layer.
"""

from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  cwd TEXT,
  agent TEXT DEFAULT 'accept-edits',
  model TEXT DEFAULT 'mistral-large-4',
  reasoning TEXT,
  status TEXT DEFAULT 'idle',
  lane TEXT DEFAULT 'code',
  last_event_id INTEGER DEFAULT 0,
  created_at REAL,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT,
  detail TEXT,
  ts REAL
);
CREATE TABLE IF NOT EXISTS costs (
  session_id TEXT PRIMARY KEY,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  input_price_per_million REAL DEFAULT 0,
  output_price_per_million REAL DEFAULT 0,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, source TEXT NOT NULL, model TEXT,
  event_key TEXT NOT NULL UNIQUE, prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
  estimated_cost_usd REAL NOT NULL, ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS turn_requests (
  session_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
  response TEXT, PRIMARY KEY(session_id,request_id)
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""


class Store:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _con(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path, timeout=5)
        con.row_factory = sqlite3.Row
        # WAL + busy timeout: the SSE tap, HTTP handlers, and UI polling all
        # touch the DB concurrently; this keeps readers/writers from locking.
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA busy_timeout=5000")
        return con

    def _init(self) -> None:
        con = self._con()
        con.executescript(SCHEMA)
        self._migrate(con)
        con.close()

    def _migrate(self, con: sqlite3.Connection) -> None:
        """Add any columns missing from an older VibeDeck DB (forward-compatible)."""
        existing = {r["name"] for r in con.execute("PRAGMA table_info(sessions)").fetchall()}
        # map legacy column names -> new ones
        if "agent_mode" in existing and "agent" not in existing:
            con.execute("ALTER TABLE sessions ADD COLUMN agent TEXT DEFAULT 'accept-edits'")
            con.execute("UPDATE sessions SET agent = agent_mode")
        for col, decl in [
            ("reasoning", "TEXT"),
            ("lane", "TEXT DEFAULT 'code'"),
            ("last_event_id", "INTEGER DEFAULT 0"),
            # origin: 'vibedeck' (created here) | 'vibe' (imported from the
            # shared vibe CLI session store)
            ("origin", "TEXT DEFAULT 'vibedeck'"),
            # when a legacy CLI session is resumed it is migrated to a unified
            # session id by the app-server; this records that counterpart so
            # the sidebar doesn't list the same conversation twice
            ("vibe_session_id", "TEXT"),
            ("warnings", "TEXT DEFAULT '[]'"),
        ]:
            if col not in existing:
                con.execute(f"ALTER TABLE sessions ADD COLUMN {col} {decl}")
        cost_columns = {r["name"] for r in con.execute("PRAGMA table_info(costs)")}
        if "cached_input_price_per_million" not in cost_columns:
            con.execute("ALTER TABLE costs ADD COLUMN cached_input_price_per_million REAL")
        for column, expression in (
            ("input_cost_usd", "((prompt_tokens-MIN(cached_tokens,prompt_tokens))*input_price_per_million+MIN(cached_tokens,prompt_tokens)*COALESCE(cached_input_price_per_million,input_price_per_million))/1e6"),
            ("output_cost_usd", "completion_tokens*output_price_per_million/1e6"),
        ):
            if column not in cost_columns:
                con.execute(f"ALTER TABLE costs ADD COLUMN {column} REAL DEFAULT 0")
                con.execute(f"UPDATE costs SET {column}={expression}")
        con.commit()

    # ---- sessions
    def upsert_session(self, sid: str, **fields: Any) -> None:
        fields.setdefault("updated_at", time.time())
        if "created_at" not in fields:
            fields["created_at"] = time.time()
        cols = ",".join(fields.keys())
        placeholders = ",".join("?" for _ in fields)
        updates = ",".join(
            f"{k}=excluded.{k}" if k != "created_at"
            else "created_at=COALESCE(sessions.created_at,excluded.created_at)"
            for k in fields if k != "id")
        con = self._con()
        con.execute(
            f"INSERT INTO sessions(id,{cols}) VALUES(?,{placeholders}) "
            f"ON CONFLICT(id) DO UPDATE SET {updates}",
            (sid, *fields.values()),
        )
        con.commit()
        con.close()

    def get_session(self, sid: str) -> Optional[dict]:
        con = self._con()
        row = con.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        con.close()
        return dict(row) if row else None

    def list_sessions(self) -> list[dict]:
        con = self._con()
        rows = con.execute("SELECT * FROM sessions ORDER BY updated_at DESC").fetchall()
        con.close()
        return [dict(r) for r in rows]

    def list_sessions_with_costs(self) -> list[dict]:
        """Sessions with their cost row attached — one query, no N+1."""
        con = self._con()
        rows = con.execute(
            "SELECT s.*, c.prompt_tokens, c.completion_tokens, c.cached_tokens, "
            "c.input_price_per_million, c.output_price_per_million, c.updated_at AS cost_updated_at "
            "FROM sessions s LEFT JOIN costs c ON c.session_id = s.id "
            "ORDER BY s.updated_at DESC").fetchall()
        con.close()
        out = []
        for r in rows:
            d = dict(r)
            d["costs"] = {
                "session_id": d["id"],
                "prompt_tokens": d.pop("prompt_tokens") or 0,
                "completion_tokens": d.pop("completion_tokens") or 0,
                "cached_tokens": d.pop("cached_tokens") or 0,
                "input_price_per_million": d.pop("input_price_per_million") or 0,
                "output_price_per_million": d.pop("output_price_per_million") or 0,
                "updated_at": d.pop("cost_updated_at"),
            }
            out.append(d)
        return out

    def delete_session(self, sid: str) -> None:
        con = self._con()
        con.execute("DELETE FROM sessions WHERE id=?", (sid,))
        con.execute("DELETE FROM turn_requests WHERE session_id=?", (sid,))
        # Usage survives conversation deletion; it is accounting history.
        con.commit()
        con.close()

    def set_session_status(self, sid: str, status: str) -> None:
        con = self._con()
        con.execute("UPDATE sessions SET status=?, updated_at=? WHERE id=?",
                    (status, time.time(), sid))
        con.commit()
        con.close()

    # ---- costs
    def upsert_costs(self, sid: str, stats: dict, event_key: str | None = None,
                     model: str | None = None) -> None:
        con = self._con()
        try:
            con.execute("BEGIN IMMEDIATE")
            previous = con.execute("SELECT * FROM costs WHERE session_id=?", (sid,)).fetchone()
            if event_key is not None and con.execute(
                    "SELECT 1 FROM usage_events WHERE event_key=?", (f"vibe:{sid}:{event_key}",)).fetchone():
                return
            prompt = max(0, int(stats.get("sessionPromptTokens", 0)))
            completion = max(0, int(stats.get("sessionCompletionTokens", 0)))
            cached = min(prompt, max(0, int(stats.get("sessionCachedTokens", 0))))
            ip = float(stats.get("inputPricePerMillion", 0) or 0)
            op = float(stats.get("outputPricePerMillion", 0) or 0)
            cp = stats.get("cachedInputPricePerMillion")
            cp = ip if cp is None else float(cp)
            stamp = time.time()
            # Prices apply to increments, never to earlier turns on another model.
            reset = previous is not None and (prompt < previous["prompt_tokens"] or completion < previous["completion_tokens"])
            dp = prompt if previous is None or reset else max(0, prompt - previous["prompt_tokens"])
            dc = completion if previous is None or reset else max(0, completion - previous["completion_tokens"])
            dca = min(dp, cached if previous is None or reset else max(0, cached - previous["cached_tokens"]))
            input_cost = (previous["input_cost_usd"] if previous else 0) + ((dp-dca)*ip+dca*cp)/1e6
            output_cost = (previous["output_cost_usd"] if previous else 0) + dc*op/1e6
            # Store only observed increments: old snapshots are not daily history.
            if event_key is not None and previous is not None:
                if dp or dc:
                    cost = ((dp - dca) * ip + dca * cp + dc * op) / 1e6
                    con.execute(
                        "INSERT OR IGNORE INTO usage_events(session_id,source,model,event_key,"
                        "prompt_tokens,completion_tokens,cached_tokens,estimated_cost_usd,ts) "
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                        (sid, "vibe", model, f"vibe:{sid}:{event_key}", dp, dc, dca, cost, stamp))
            con.execute(
                "INSERT INTO costs(session_id,prompt_tokens,completion_tokens,cached_tokens,"
                "input_price_per_million,output_price_per_million,cached_input_price_per_million,updated_at,input_cost_usd,output_cost_usd) "
                "VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET "
                "prompt_tokens=excluded.prompt_tokens,completion_tokens=excluded.completion_tokens,"
                "cached_tokens=excluded.cached_tokens,input_price_per_million=excluded.input_price_per_million,"
                "output_price_per_million=excluded.output_price_per_million,"
                "cached_input_price_per_million=excluded.cached_input_price_per_million,updated_at=excluded.updated_at,"
                "input_cost_usd=excluded.input_cost_usd,output_cost_usd=excluded.output_cost_usd",
                (sid, prompt, completion, cached, ip, op, cp, stamp, input_cost, output_cost))
            con.commit()
        finally:
            con.close()

    def record_api_usage(self, request_id: str, model: str, usage: dict) -> None:
        prompt = max(0, int(usage.get("prompt_tokens", 0)))
        completion = max(0, int(usage.get("completion_tokens", 0)))
        cached = min(prompt, max(0, int(usage.get("prompt_tokens_details", {}).get("cached_tokens", 0))))
        with self._con() as con:
            con.execute(
                "INSERT OR IGNORE INTO usage_events(session_id,source,model,event_key,"
                "prompt_tokens,completion_tokens,cached_tokens,estimated_cost_usd,ts) VALUES(?,?,?,?,?,?,?,?,?)",
                (request_id, "playground", model, f"api:{request_id}", prompt, completion, cached, 0, time.time()))
        con.close()

    def usage_activity(self, start: float, end: float) -> dict:
        con = self._con()
        rows = con.execute(
            "SELECT date(ts,'unixepoch') AS day,model,source,SUM(prompt_tokens) AS prompt_tokens,"
            "SUM(completion_tokens) AS completion_tokens,SUM(cached_tokens) AS cached_tokens,"
            "SUM(estimated_cost_usd) AS estimated_cost_usd FROM usage_events WHERE ts>=? AND ts<? "
            "GROUP BY day,model,source ORDER BY day", (start, end)).fetchall()
        first = con.execute("SELECT MIN(ts) FROM usage_events").fetchone()[0]
        con.close()
        return {"rows": [dict(r) for r in rows], "observedSince": first,
                "historicalTotals": self.total_costs()}

    def get_costs(self, sid: str) -> dict:
        con = self._con()
        row = con.execute("SELECT * FROM costs WHERE session_id=?", (sid,)).fetchone()
        con.close()
        return dict(row) if row else {}

    def total_costs(self) -> dict:
        con = self._con()
        row = con.execute(
            "SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c, "
            "COALESCE(SUM(cached_tokens),0) ca, "
            "COALESCE(SUM(input_cost_usd),0) ic, "
            "COALESCE(SUM(output_cost_usd),0) oc FROM costs").fetchone()
        con.close()
        result = dict(row)
        result["estimated_cost_usd"] = round(result["ic"] + result["oc"], 6)
        return result

    # ---- transport retries (the native server's replay path can deadlock)
    def get_turn_request(self, sid: str, request_id: str) -> dict | None:
        con = self._con()
        row = con.execute("SELECT * FROM turn_requests WHERE session_id=? AND request_id=?", (sid, request_id)).fetchone()
        con.close()
        return dict(row) if row else None

    def set_turn_request(self, sid: str, request_id: str, payload_hash: str, response: dict | None = None) -> None:
        with self._con() as con:
            con.execute("INSERT INTO turn_requests VALUES(?,?,?,?) ON CONFLICT(session_id,request_id) "
                        "DO UPDATE SET response=excluded.response", (sid, request_id, payload_hash,
                        json.dumps(response) if response is not None else None))
        con.close()

    def forget_turn_request(self, sid: str, request_id: str) -> None:
        with self._con() as con:
            con.execute("DELETE FROM turn_requests WHERE session_id=? AND request_id=?", (sid, request_id))
        con.close()

    # ---- config
    def get_config(self, key: str, default: Any = None) -> Any:
        con = self._con()
        row = con.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
        con.close()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except Exception:
            return row["value"]

    def set_config(self, key: str, value: Any) -> None:
        con = self._con()
        con.execute("INSERT INTO config(key,value) VALUES(?,?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (key, json.dumps(value)))
        con.commit()
        con.close()

    # ---- audit
    def audit(self, action: str, detail: str = "") -> None:
        con = self._con()
        con.execute("INSERT INTO audit(action,detail,ts) VALUES(?,?,?)",
                    (action, detail, time.time()))
        con.commit()
        con.close()

    def list_audit(self, limit: int = 100) -> list[dict]:
        con = self._con()
        rows = con.execute("SELECT * FROM audit ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        con.close()
        return [dict(r) for r in rows]
