"""Direct Mistral API access for VibeDeck.

Responsibilities:
  1. Manage the user's Mistral API key so the direct-chat surface and the Studio
     playground work. Resolution order: environment variable -> explicit
     "disabled" marker in the vibedeck env file -> system keyring -> vibedeck
     env file. The key can be added and removed at will (set_api_key /
     remove_api_key); it is never logged or written to the DB.
  2. Thin async helpers over api.mistral.ai: chat completions (streaming), model
     catalog, and usage.

The vibe CLI / app-server uses Vibe's own auth; this module is only for the
API-billed surfaces (Studio Playground + direct chat).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Optional

import httpx

MISTRAL_BASE = "https://api.mistral.ai/v1"

# Models that accept the reasoning_effort parameter (adjustable reasoning).
ADJUSTABLE_REASONING = ("mistral-small-latest", "mistral-small-2603", "mistral-medium-3-5",
                        "mistral-medium-latest", "mistral-large-4", "mistral-large-latest", "zai-glm-5-3")

# Mistral API keys are long opaque tokens; this strict shape also keeps the
# env-file writer safe from injection (no whitespace, quotes, or newlines).
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{20,}$")

# Marker written to the env file when the user removes the key: an explicit
# "no key" that wins over the keyring (which is shared with the vibe CLI and
# must not be touched).
DISABLED_MARKER = "VIBEDECK_API_KEY_DISABLED"


def env_file_path() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "vibedeck" / "env"


def _keyring_key() -> Optional[str]:
    """Look the key up in the system keyring (same store the vibe CLI uses)."""
    try:
        import keyring  # type: ignore
        for svc in ("ai.mistral.vibe", "vibe"):
            v = keyring.get_password(svc, "MISTRAL_API_KEY")
            if v and len(v) > 10:
                return v
    except Exception:
        pass
    return None


def _read_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines (tolerates ``export `` prefixes and quotes)."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _update_env_file(path: Path, updates: dict[str, Optional[str]]) -> None:
    """Apply key updates to the env file line-wise, atomically.

    ``updates`` maps key -> new value, or None to remove the key. Comments,
    blank lines, and unrelated keys are preserved verbatim.
    """
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    lines = path.read_text().splitlines() if path.exists() else []
    out: list[str] = []
    seen: set[str] = set()
    for line in lines:
        stripped = line.strip()
        key: Optional[str] = None
        if stripped and not stripped.startswith("#"):
            body = stripped[len("export "):] if stripped.startswith("export ") else stripped
            if "=" in body:
                key = body.partition("=")[0].strip()
        if key is not None and key in updates:
            seen.add(key)
            val = updates[key]
            if val is not None:
                out.append(f"{key}={val}")
            continue  # removed or replaced in place
        out.append(line)
    for key, val in updates.items():
        if key not in seen and val is not None:
            out.append(f"{key}={val}")
    fd, temporary = tempfile.mkstemp(prefix=".env-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write("\n".join(out) + ("\n" if out else ""))
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _valid_key(key: str) -> bool:
    return bool(key) and key != "YOUR_KEY" and bool(_KEY_RE.match(key))


def resolve_api_key() -> Optional[str]:
    """Resolve the effective Mistral API key, or None if unset/disabled."""
    # 1. environment (most explicit system-level override)
    key = os.environ.get("MISTRAL_API_KEY")
    if key and key != "YOUR_KEY" and len(key) > 10:
        return key
    # 2. explicit removal marker in the vibedeck env file
    entries = _read_env_file(env_file_path())
    if entries.get(DISABLED_MARKER) == "1":
        return None
    # An explicit desktop key must override the shared CLI fallback.
    val = entries.get("MISTRAL_API_KEY", "")
    if val and val != "YOUR_KEY" and len(val) > 10:
        return val
    return _keyring_key()


def _fingerprint(key: Optional[str]) -> Optional[str]:
    """Masked key preview (first 4 + last 4) — safe to render, never the key."""
    if not key or len(key) < 12:
        return None
    return f"{key[:4]}…{key[-4:]}"


def api_key_status() -> dict:
    """Where the effective key comes from — never includes the key itself."""
    key = os.environ.get("MISTRAL_API_KEY")
    if key and key != "YOUR_KEY" and len(key) > 10:
        return {"present": True, "source": "env", "disabled": False,
                "file": str(env_file_path()), "fingerprint": _fingerprint(key)}
    entries = _read_env_file(env_file_path())
    if entries.get(DISABLED_MARKER) == "1":
        return {"present": False, "source": "disabled", "disabled": True,
                "file": str(env_file_path()), "fingerprint": None}
    val = entries.get("MISTRAL_API_KEY", "")
    if val and val != "YOUR_KEY" and len(val) > 10:
        return {"present": True, "source": "file", "disabled": False,
                "file": str(env_file_path()), "fingerprint": _fingerprint(val)}
    kr = _keyring_key()
    if kr:
        return {"present": True, "source": "keyring", "disabled": False,
                "file": str(env_file_path()), "fingerprint": _fingerprint(kr)}
    return {"present": False, "source": None, "disabled": False,
            "file": str(env_file_path()), "fingerprint": None}


def set_api_key(key: str) -> None:
    """Store the key in the vibedeck env file (0600), clearing any disabled marker."""
    key = (key or "").strip()
    if not _valid_key(key):
        raise ValueError(
            "invalid API key: expected a Mistral token (letters, digits, '-' or '_', 20+ chars)"
        )
    _update_env_file(env_file_path(), {"MISTRAL_API_KEY": key, DISABLED_MARKER: None})


def remove_api_key() -> bool:
    """Remove the stored key and mark the key disabled (wins over the keyring).

    Returns True if a stored key line was removed. The keyring entry is left
    alone — it belongs to the vibe CLI's own auth.
    """
    path = env_file_path()
    had_key = "MISTRAL_API_KEY" in _read_env_file(path)
    _update_env_file(path, {"MISTRAL_API_KEY": None, DISABLED_MARKER: "1"})
    return had_key


def _headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


async def list_models(key: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(f"{MISTRAL_BASE}/models", headers=_headers(key))
        resp.raise_for_status()
        data = resp.json().get("data", [])
        out = []
        for m in data:
            caps = m.get("capabilities", {})
            out.append({
                "id": m.get("id"),
                "name": m.get("name") or m.get("id"),
                "description": m.get("description", ""),
                "maxContextLength": m.get("max_context_length"),
                "functionCalling": bool(caps.get("function_calling")),
                "vision": bool(caps.get("vision")),
                "ownedBy": m.get("owned_by", ""),
            })
        return out


def _admin_key() -> Optional[str]:
    """Optional Admin API key (Backoffice) for org-level usage metrics."""
    key = os.environ.get("MISTRAL_ADMIN_API_KEY")
    if key and len(key) > 10:
        return key
    val = _read_env_file(env_file_path()).get("MISTRAL_ADMIN_API_KEY", "")
    if val and len(val) > 10:
        return val
    return None


async def get_usage(key: str) -> dict:
    """Org-level usage snapshot from Mistral's Admin API (``/v1/admin/usage``).

    A regular API key has no usage endpoint on api.mistral.ai (every usage
    path 404s) — org usage metrics require an Admin API key created in the
    Backoffice (console.mistral.ai). Set ``MISTRAL_ADMIN_API_KEY`` (env or
    ~/.config/vibedeck/env) to enable it; without it we say so instead of
    surfacing a bare 404. The ``key`` argument is kept for call compatibility.
    """
    admin = _admin_key()
    if not admin:
        return {
            "source": "none",
            "detail": "Organization usage needs an Admin API key (console.mistral.ai → "
                      "Backoffice → Admin API keys). Set MISTRAL_ADMIN_API_KEY in "
                      "~/.config/vibedeck/env to enable it. Per-session token and "
                      "cost tracking below is computed locally.",
        }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{MISTRAL_BASE}/admin/usage",
                                    headers={"x-api-key": admin})
            if resp.status_code == 200:
                return {"source": "admin", "data": resp.json()}
            return {"source": "none",
                    "detail": f"admin usage endpoint returned {resp.status_code}"}
    except Exception as e:  # noqa: BLE001
        return {"source": "none", "detail": str(e)}


def parse_stream_delta(d: dict) -> tuple[str, str]:
    """Return (stream, text): stream in 'think'|'text'|'', text payload."""
    try:
        delta = d["choices"][0].get("delta", {})
    except (KeyError, IndexError):
        return "", ""
    c = delta.get("content")
    if isinstance(c, str):
        return "text", c
    if isinstance(c, list):
        out: list[str] = []
        stream = ""
        for chunk in c:
            if isinstance(chunk, dict):
                if "thinking" in chunk:
                    stream = "think"
                    for inner in chunk["thinking"] or []:
                        if isinstance(inner, dict) and inner.get("text"):
                            out.append(inner["text"])
                elif chunk.get("text"):
                    out.append(chunk["text"])
        return stream, "".join(out)
    return "", ""


def stream_deltas(data: dict):
    choices = data.get("choices") or []
    if not choices:
        return
    content = choices[0].get("delta", {}).get("content")
    if isinstance(content, str):
        yield "text", content
    elif isinstance(content, list):
        for chunk in content:
            if not isinstance(chunk, dict):
                continue
            if chunk.get("text"):
                yield "text", chunk["text"]
            for thought in chunk.get("thinking") or []:
                if isinstance(thought, dict) and thought.get("text"):
                    yield "think", thought["text"]


async def chat_stream(key: str, model: str, messages: list[dict],
                      reasoning_effort: Optional[str] = None,
                      temperature: Optional[float] = None,
                      max_tokens: Optional[int] = None, on_usage=None, generation: Optional[dict] = None):
    """Stream a chat completion. Yields SSE data strings."""
    body: dict[str, Any] = {"model": model, "messages": messages, "stream": True,
                            "stream_options": {"include_usage": True}}
    for name in ("top_p", "random_seed", "presence_penalty", "frequency_penalty", "stop", "safe_prompt"):
        if generation and name in generation:
            body[name] = generation[name]
    if generation and generation.get("json_mode"):
        body["response_format"] = {"type": "json_object"}
        body["messages"] = [{"role": "system", "content": "Respond with a valid JSON object."}, *messages]
    if reasoning_effort and model in ADJUSTABLE_REASONING:
        body["reasoning_effort"] = reasoning_effort
    if temperature is not None:
        body["temperature"] = temperature
        if temperature == 0:
            body["top_p"] = 1  # greedy sampling requires top_p=1
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    async with httpx.AsyncClient(timeout=300) as client:
        async with client.stream("POST", f"{MISTRAL_BASE}/chat/completions",
                                 headers=_headers(key), json=body) as resp:
            if resp.status_code != 200:
                detail = (await resp.aread()).decode()[:300]
                yield f"data: {json.dumps({'error': f'mistral {resp.status_code}: {detail}'})}\n\n"
                return
            async for line in resp.aiter_lines():
                if line.startswith("data:"):
                    payload = line[5:].lstrip(" ")
                    if payload.strip() == "[DONE]":
                        break
                    try:
                        d = json.loads(payload)
                        if d.get("usage") and on_usage:
                            on_usage(d["usage"])
                        for stream, text in stream_deltas(d):
                            if text:
                                yield f"data: {json.dumps({'stream': stream, 'delta': text})}\n\n"
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
            yield "data: [DONE]\n\n"


async def completion(key: str, model: str, messages: list[dict],
                     temperature: Optional[float] = None,
                     max_tokens: Optional[int] = None,
                     reasoning_effort: Optional[str] = None, generation: Optional[dict] = None) -> dict:
    """Non-streaming completion for the Studio playground."""
    body: dict[str, Any] = {"model": model, "messages": messages, "stream": False}
    for name in ("top_p", "random_seed", "presence_penalty", "frequency_penalty", "stop", "safe_prompt"):
        if generation and name in generation:
            body[name] = generation[name]
    if generation and generation.get("json_mode"):
        body["response_format"] = {"type": "json_object"}
        body["messages"] = [{"role": "system", "content": "Respond with a valid JSON object."}, *messages]
    if reasoning_effort and model in ADJUSTABLE_REASONING:
        body["reasoning_effort"] = reasoning_effort
    if temperature is not None:
        body["temperature"] = temperature
        if temperature == 0:
            body["top_p"] = 1  # greedy sampling requires top_p=1
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(f"{MISTRAL_BASE}/chat/completions",
                                 headers=_headers(key), json=body)
        resp.raise_for_status()
        return resp.json()
