"""Read-only account and billing snapshots. No session or model is started here."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import time
import tomllib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from mistral_api import MISTRAL_BASE, _admin_key, _keyring_key, _read_env_file


def measured_at() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_billing(data: dict, source: str) -> dict:
    if not isinstance(data, dict) or not any(k in data for k in ("completion", "chat", "vibe_code", "start_date")):
        raise ValueError("Unrecognized billing response")
    prices = data.get("prices") or []
    keys = ("event_type", "billing_metric", "billing_group", "api_zone", "service_tier")
    index = {}
    for price in prices:
        try:
            value = float(price["price"])
            if math.isfinite(value):
                index[tuple(price.get(k) for k in keys)] = value
        except (KeyError, ValueError, TypeError):
            continue
    rows: dict[tuple, dict] = {}
    cost = 0.0
    missing_price = False
    tokens = {"inputTokens": 0, "outputTokens": 0, "cachedTokens": 0}
    categories = [(data.get(name), name in ("completion", "chat"))
                  for name in ("completion", "chat", "ocr", "audio", "audio_characters", "connectors")]
    categories.append(((data.get("vibe_code") or {}).get("completion"), True))
    libraries = data.get("libraries_api") or {}
    categories.extend((libraries.get(name), False) for name in ("pages", "tokens"))
    fine = data.get("fine_tuning") or {}
    categories.extend(({"models": fine.get(name)}, False) for name in ("training", "storage"))
    for category, counts_tokens in categories:
        if category is not None and not isinstance(category, dict):
            raise ValueError("Unrecognized billing category")
        models = (category or {}).get("models") or {}
        if not isinstance(models, dict):
            raise ValueError("Unrecognized billing model data")
        for model, lanes in models.items():
            if lanes is not None and not isinstance(lanes, dict):
                raise ValueError("Unrecognized billing lanes")
            for lane, metric in (("input", "inputTokens"), ("output", "outputTokens"), ("cached", "cachedTokens")):
                for event in (lanes or {}).get(lane) or []:
                    if not isinstance(event, dict):
                        raise ValueError("Unrecognized billing event")
                    used = event.get("value", event.get("value_paid", 0))
                    paid = event.get("value_paid", event.get("value", 0))
                    if not isinstance(used, (int, float)) or not isinstance(paid, (int, float)):
                        raise ValueError("Invalid billing units")
                    if not math.isfinite(used) or not math.isfinite(paid) or abs(used) > 2**53 - 1 or abs(paid) > 2**53 - 1:
                        raise ValueError("Billing units exceed supported range")
                    key = tuple(event.get(k) for k in keys)
                    price = index.get(key, index.get((*key[:3], None, None)))
                    if price is None and paid != 0:
                        missing_price = True
                    amount = paid * price if price is not None else 0
                    cost += amount
                    if counts_tokens:
                        tokens[metric] += used
                    day = str(event.get("timestamp", ""))[:10]
                    row = rows.setdefault((day, model), {"day": day, "model": model, "inputTokens": 0,
                        "outputTokens": 0, "cachedTokens": 0, "cost": 0})
                    row["cost"] += amount
                    if counts_tokens:
                        row[metric] += used
    if not math.isfinite(cost) or any(abs(n) > 2**53 - 1 for n in tokens.values()):
        raise ValueError("Billing totals exceed supported range")
    return {"status": "partial" if missing_price else "ready", "source": source,
            "measuredAt": measured_at(), "currency": data.get("currency"),
            "cost": None if missing_price else cost, **tokens, "rows": list(rows.values()),
            "startDate": data.get("start_date"), "endDate": data.get("end_date"),
            "detail": "Some billing prices were unavailable." if missing_price else None}


def cli_key() -> str | None:
    key = os.environ.get("MISTRAL_API_KEY")
    if not key or key == "YOUR_KEY" or len(key) <= 10:
        home = Path(os.environ.get("VIBE_HOME", Path.home() / ".vibe"))
        key = _read_env_file(home / ".env").get("MISTRAL_API_KEY") or _keyring_key()
    return key


class UsageReader:
    def __init__(self):
        self._cache: dict[tuple, dict] = {}
        self._lock = asyncio.Lock()

    async def read(self, year: int, month: int, refresh: bool = False) -> dict:
        admin = _admin_key()
        # Credentials never enter a public snapshot or a log.
        identity = hashlib.sha256(json.dumps([admin, cli_key()]).encode()).hexdigest()
        cache_key = (year, month, identity, os.environ.get("VIBE_HOME"))
        async with self._lock:
            previous = self._cache.get(cache_key)
            if previous and (not refresh or time.time() - previous["_fetched"] < 10):
                if time.time() - previous["_fetched"] < 300:
                    return {k: v for k, v in previous.items() if k != "_fetched"}
            result: dict[str, Any] = {"status": "partial", "source": "admin", "measuredAt": measured_at(),
                "account": await self._cli_account(), "allowances": [], "billing": None,
                "detail": "Connect your Mistral usage account to view subscription allowances."}
            if admin:
                try:
                    async with httpx.AsyncClient(timeout=15) as client:
                        response = await client.get(f"{MISTRAL_BASE}/admin/usage", params={"month": month, "year": year},
                                                    headers={"x-api-key": admin})
                        response.raise_for_status()
                        result["billing"] = normalize_billing(response.json(), "admin")
                        limits = await client.get(f"{MISTRAL_BASE}/admin/spend-limit", headers={"x-api-key": admin})
                        if limits.is_success:
                            payload = limits.json().get("limits", {})
                            result["limits"] = {"currency": payload.get("currency"),
                                "monthlyLimitReached": (payload.get("completion") or {}).get("monthly_limit_reached")}
                except httpx.HTTPStatusError as exc:
                    result["detail"] = f"Admin billing returned HTTP {exc.response.status_code}. Check the Admin key and organization."
                except (httpx.RequestError, ValueError):
                    result["detail"] = "Admin billing is unavailable. Local usage is still available."
                if result["billing"] is None and previous and previous.get("billing"):
                    result["billing"] = {**previous["billing"], "status": "stale"}
            if len(self._cache) > 24:
                self._cache.clear()
            self._cache[cache_key] = {**result, "_fetched": time.time()}
            return result

    async def _cli_account(self) -> dict:
        key = cli_key()
        if not key:
            return {"status": "disconnected", "source": "cli", "label": "Vibe CLI account", "plan": None}
        home = Path(os.environ.get("VIBE_HOME", Path.home() / ".vibe"))
        try:
            entries = json.loads((home / "whoami_cache.json").read_text())
            entry = entries.get(hashlib.sha256(key.encode()).hexdigest()[:32], {})
            payload = entry.get("payload")
            if payload and time.time() - entry.get("stored_at_timestamp", 0) < 21600:
                return {"status": "ready", "source": "cli", "label": "Vibe CLI account",
                        "plan": payload.get("plan_name"), "kind": payload.get("plan_type")}
        except (OSError, ValueError, TypeError):
            pass
        base = "https://console.mistral.ai"
        try:
            config = tomllib.loads((home / "config.toml").read_text())
            base = config.get("console_base_url", base)
        except (OSError, ValueError):
            pass
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                response = await client.get(f"{base.rstrip('/')}/api/vibe/whoami", headers={"Authorization": f"Bearer {key}"})
            if response.status_code in (401, 403):
                return {"status": "expired", "source": "cli", "label": "Vibe CLI account", "plan": None}
            response.raise_for_status()
            payload = response.json()
            return {"status": "ready", "source": "cli", "label": "Vibe CLI account",
                    "plan": payload.get("plan_name"), "kind": payload.get("plan_type")}
        except (httpx.HTTPError, ValueError):
            return {"status": "unavailable", "source": "cli", "label": "Vibe CLI account", "plan": None}
