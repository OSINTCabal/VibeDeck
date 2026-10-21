"""Multi-provider management for VibeDeck.

Lets the user add AI providers beyond the built-in Mistral one and use their
models anywhere a vibe model can be used (session model pickers, defaults) or
as bounded provider workers through a shared native MCP server.

How it works:
  * Providers and models are declared in the vibe CLI's own user config
    (``$VIBE_HOME/config.toml``, default ``~/.vibe/config.toml``) as
    ``[[providers]]`` / ``[[models]]`` tables — the same file the vibe CLI
    reads, so every app-server the sidecar spawns picks the new models up
    automatically and they appear in the app-server's model registry (which
    the sidecar already surfaces as ``/api/config`` ``vibeModels``).
  * The config file is edited with a TOML parser and an atomic replace: comments, blank
    lines, and unrelated tables are preserved verbatim.
  * Provider API keys are written to the system keyring under the same
    service the vibe CLI uses (``ai.mistral.vibe``), with the username being
    the provider's ``api_key_env_var``. The vibe CLI resolves keys as
    "env var first, then keyring", so keyring entries are picked up live by
    newly spawned app-servers without a sidecar restart. Keys are never
    logged, written to the DB, or returned by any endpoint.

OPSEC: the keyring is the only place provider keys live; this module never
echoes them.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

import tomlkit
from agent_routing import AgentSettings, sync_instructions
from tomlkit.items import Array

# Same store the vibe CLI uses (vibe/utils/keyring.py).
KEYRING_SERVICE = "ai.mistral.vibe"
LEGACY_KEYRING_SERVICES = ("vibe",)

_PROVIDER_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
_ENV_VAR_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
_ALIAS_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_KEY_RE = re.compile(r"^\S{8,512}$")

API_STYLES = ("openai", "anthropic", "openai-responses", "reasoning")
BACKENDS = ("generic", "mistral")
THINKING_LEVELS = ("off", "low", "medium", "high", "max")

# The built-in provider; users must not shadow it.
RESERVED_PROVIDER = "mistral"

# Bases are protocol-specific: Vibe appends /v1/messages for Anthropic.
PRESETS = [
    {"name": "codex", "label": "Codex / ChatGPT sign-in", "api_base": "http://127.0.0.1:9377/api/codex/v1", "api_style": "openai", "api_key_env_var": "VIBEDECK_CODEX_TOKEN", "help": "Uses the official Codex CLI's saved ChatGPT login. Text/tool messages only; output limits are advisory in the native Codex protocol. No OAuth token is copied. VibeDeck must be running for CLI access to this provider."},
    {"name": "openai", "label": "OpenAI API / Codex API", "api_base": "https://api.openai.com/v1", "api_style": "openai-responses", "api_key_env_var": "OPENAI_API_KEY", "help": "Use an OpenAI API key and a model available to your API account."},
    {"name": "claude", "label": "Claude API", "api_base": "https://api.anthropic.com", "api_style": "anthropic", "api_key_env_var": "ANTHROPIC_API_KEY", "help": "Use an Anthropic API key. Claude web subscriptions are separate."},
    {"name": "deepseek", "label": "DeepSeek API", "api_base": "https://api.deepseek.com", "api_style": "openai", "api_key_env_var": "DEEPSEEK_API_KEY", "help": "Enter the model ID enabled for your DeepSeek account."},
    {"name": "zai", "label": "Z.ai API", "api_base": "https://api.z.ai/api/paas/v4", "api_style": "openai", "api_key_env_var": "ZAI_API_KEY", "help": "Standard API billing. Coding Plan access depends on Z.ai's supported-tool policy."},
    {"name": "minimax", "label": "MiniMax.io Token Plan / API", "api_base": "https://api.minimax.io/v1", "api_style": "openai", "api_key_env_var": "MINIMAX_API_KEY", "help": "Paste your Token Plan subscription key or API key. The two have separate quotas."},
    {"name": "google", "label": "Google AI Studio", "api_base": "https://generativelanguage.googleapis.com/v1beta/openai", "api_style": "openai", "api_key_env_var": "GEMINI_API_KEY", "help": "Create a Gemini API key in AI Studio using your regular browser. Google website sign-in alone is not an API credential."},
    {"name": "ollama", "label": "Ollama (local)", "api_base": "http://127.0.0.1:11434/v1", "api_style": "openai", "api_key_env_var": "", "help": "Start Ollama and enter the name of a pulled model. Main-agent delegation requires a model that supports tools. Text-only models can still be workers."},
]
MANAGED_AGENT = "# Managed by VibeDeck: provider subagent\n"
PLAN_PROFILE = ('display_name = "Plan"\n'
                'description = "Read and plan without editing"\n'
                'safety = "safe"\n'
                'instructions = "Inspect the project and provide a plan. Do not change files."\n'
                'enabled_tools = ["read_file", "grep"]\n')


def sync_subagents(path: Optional[Path] = None, settings: AgentSettings | None = None) -> None:
    """Install the shared MCP tool and the read-only Plan mode profile."""
    path = path or vibe_config_path()
    tools = path.parent / "vibedeck"
    tools.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).parent / "provider_tools/provider_task.py"
    target = tools / "provider_task.py"
    text = source.read_text()
    existing = _read_text(target)
    marker = '# Managed by VibeDeck: provider routing tool\n'
    if existing and not existing.startswith(marker):
        raise ValueError("An independent provider_task.py already exists; rename it before enabling provider workers")
    helper = tools / "agent_routing.py"
    if helper.exists() and not helper.read_text().startswith(marker):
        raise ValueError("An independent agent_routing.py exists; rename it before enabling provider workers")
    helper_text = marker + (Path(__file__).parent / "agent_routing.py").read_text()
    if _read_text(helper) != helper_text:
        fd, temporary = tempfile.mkstemp(prefix=".agent-routing-", dir=tools)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(helper_text)
            os.replace(temporary, helper)
        finally:
            Path(temporary).unlink(missing_ok=True)
    if existing != marker + text:
        # Atomic and same-directory, like config edits; there are no secrets here.
        fd, temporary = tempfile.mkstemp(prefix=".provider-task-", dir=tools)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(marker + text)
            os.chmod(temporary, 0o600)
            if _read_text(target) != existing:
                raise ValueError("Provider tool changed externally; refresh before saving")
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
    original, document = _document(path)
    servers = document.get("mcp_servers", [])
    managed = next((s for s in servers if s.get("name") == "vibedeck_providers"), None)
    if managed and managed.get("args") != [str(target)]:
        raise ValueError("An independent vibedeck_providers MCP server exists; rename it first")
    executable = shutil.which("vibe")
    if not executable and (Path.home() / ".local/bin/vibe").is_file():
        executable = str(Path.home() / ".local/bin/vibe")
    python = sys.executable
    if executable:
        first = Path(executable).read_bytes().split(b"\n", 1)[0].decode()
        if first.startswith("#!/") and "python" in first:
            python = first[2:]
    server = {"name": "vibedeck_providers", "transport": "stdio", "command": python,
              "args": [str(target)], "env": {"VIBE_HOME": str(path.parent)}, "tool_timeout_sec": 400}
    if managed is None:
        if "mcp_servers" not in document:
            document["mcp_servers"] = tomlkit.aot()
        document["mcp_servers"].append(server)
    else:
        managed.update(server)
    _write_document(path, original, document)
    # Vibe 3 removed its built-in plan agent; preserve an existing user profile.
    plan = path.parent / "agents/plan.toml"
    plan.parent.mkdir(parents=True, exist_ok=True)
    if not plan.exists():
        fd, temporary = tempfile.mkstemp(prefix=".plan-", dir=plan.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(PLAN_PROFILE)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.link(temporary, plan)
            except FileExistsError:
                pass
        finally:
            Path(temporary).unlink(missing_ok=True)
    sync_instructions(path.parent, settings)
    legacy_tool = path.parent / "tools/provider_task.py"
    if _read_text(legacy_tool).startswith(marker):
        legacy_tool.unlink()
    for target in (path.parent / "agents").glob("vibedeck-*.toml"):
        if _read_text(target).startswith(MANAGED_AGENT):
            target.unlink()


def vibe_config_path() -> Path:
    """The vibe CLI's user config — honors VIBE_HOME exactly like the CLI."""
    home = os.environ.get("VIBE_HOME") or str(Path.home() / ".vibe")
    return Path(home).expanduser() / "config.toml"


# ---------------------------------------------------------------- TOML editing



def _read_text(path: Path) -> str:
    return path.read_text() if path.exists() else ""


def _document(path: Path):
    text = _read_text(path)
    try:
        return text, tomlkit.parse(text)
    except Exception as exc:
        raise ValueError("Vibe configuration is invalid TOML; no changes were written") from exc


def _write_document(path: Path, original: str, document) -> None:
    text = tomlkit.dumps(document)
    tomlkit.parse(text)
    if path.exists() and text == original:
        if _read_text(path) != original:
            raise ValueError("Vibe configuration changed externally; refresh before saving")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    fd, temporary = tempfile.mkstemp(prefix=".vibedeck-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        if _read_text(path) != original:
            raise ValueError("Vibe configuration changed externally; refresh before saving")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def read_providers(path: Optional[Path] = None) -> list[dict]:
    _, document = _document(path or vibe_config_path())
    return [{"api_base": "", "api_style": "openai", "backend": "generic", "api_key_env_var": "", **dict(p)}
            for p in document.get("providers", []) if p.get("name")]


def read_models(path: Optional[Path] = None) -> list[dict]:
    _, document = _document(path or vibe_config_path())
    return [dict(m) for m in document.get("models", []) if m.get("name") and m.get("alias")]


def _upsert(document, section: str, key: str, payload: dict) -> None:
    if section not in document:
        document[section] = tomlkit.aot()
    rows = document[section]
    matches = [i for i, row in enumerate(rows) if row.get(key) == payload[key]]
    if matches:
        row = rows[matches[0]]
        for index in reversed(matches[1:]):
            del rows[index]
    else:
        row = tomlkit.inline_table() if isinstance(rows, Array) else tomlkit.table()
        rows.append(row)
    for name, value in payload.items():
        if value is not None:
            row[name] = value


def upsert_provider(provider: dict, path: Optional[Path] = None) -> None:
    apply_provider_edit(provider, [], path)


def apply_provider_edit(provider: dict, models: list[dict], path: Optional[Path] = None) -> None:
    path = path or vibe_config_path()
    original, document = _document(path)
    _upsert(document, "providers", "name", provider)
    for model in models:
        _upsert(document, "models", "alias", model)
    _write_document(path, original, document)


def remove_provider(name: str, path: Optional[Path] = None) -> bool:
    path = path or vibe_config_path()
    original, document = _document(path)
    removed = False
    aliases = set()
    for section, key in (("providers", "name"), ("models", "provider")):
        rows = document.get(section, [])
        for index in range(len(rows) - 1, -1, -1):
            if rows[index].get(key) == name:
                aliases.add(rows[index].get("alias"))
                del rows[index]
                removed = True
        if section in document and not rows:
            del document[section]
    if document.get("active_model") in aliases:
        document.pop("active_model", None)
    if removed:
        _write_document(path, original, document)
    return removed


def upsert_model(model: dict, path: Optional[Path] = None) -> None:
    path = path or vibe_config_path()
    original, document = _document(path)
    _upsert(document, "models", "alias", model)
    _write_document(path, original, document)


def remove_model(alias: str, path: Optional[Path] = None) -> bool:
    path = path or vibe_config_path()
    original, document = _document(path)
    rows = document.get("models", [])
    removed = False
    for index in range(len(rows) - 1, -1, -1):
        if rows[index].get("alias") == alias:
            del rows[index]
            removed = True
    if "models" in document and not rows:
        del document["models"]
    if document.get("active_model") == alias:
        document.pop("active_model", None)
    if removed:
        _write_document(path, original, document)
    return removed


# ---------------------------------------------------------------- validation

def validate_provider(p: dict) -> dict:
    """Normalize + validate a provider payload; raises ValueError."""
    name = str(p.get("name") or "").strip()
    if not _PROVIDER_NAME_RE.match(name):
        raise ValueError(
            "provider name must be lowercase letters/digits/dashes, starting with a letter")
    if name == RESERVED_PROVIDER:
        raise ValueError(f"'{RESERVED_PROVIDER}' is the built-in provider and cannot be replaced")
    api_base = str(p.get("api_base") or "").strip()
    try:
        url = urlsplit(api_base)
        valid = url.scheme in ("http", "https") and url.hostname and url.port != 0
        if url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"):
            valid = False
        if not valid or url.username or url.password or url.query or url.fragment:
            raise ValueError
    except ValueError:
        raise ValueError("api_base must be HTTPS, or loopback HTTP, without credentials, query or fragment") from None
    api_base = api_base.rstrip("/")
    api_style = str(p.get("api_style") or "openai").strip() or "openai"
    backend = str(p.get("backend") or "generic").strip() or "generic"
    if api_style not in API_STYLES:
        raise ValueError(f"api_style must be one of {API_STYLES}")
    if backend not in BACKENDS:
        raise ValueError(f"backend must be one of {BACKENDS}")
    env_var = str(p.get("api_key_env_var") or "").strip()
    if env_var and not _ENV_VAR_RE.match(env_var):
        raise ValueError("api_key_env_var must be an UPPER_SNAKE_CASE name (e.g. OPENAI_API_KEY)")
    return {
        "name": name, "api_base": api_base, "api_style": api_style,
        "backend": backend, "api_key_env_var": env_var,
    }


def validate_model(m: dict, known_providers: set[str]) -> dict:
    """Normalize + validate a model payload; raises ValueError."""
    name = str(m.get("name") or "").strip()
    if not name:
        raise ValueError("model name is required")
    provider = str(m.get("provider") or "").strip()
    if provider not in known_providers:
        raise ValueError(
            f"model provider '{provider}' is not configured. Available: "
            f"{', '.join(sorted(known_providers))}")
    alias = str(m.get("alias") or "").strip()
    if not _ALIAS_RE.match(alias):
        raise ValueError(
            "model alias must be lowercase letters/digits/dots/dashes/underscores, "
            "starting with a letter or digit")
    out: dict[str, Any] = {"name": name, "provider": provider, "alias": alias}
    if m.get("display_name") is not None:
        out["display_name"] = str(m["display_name"])
    if m.get("temperature") is not None:
        t = float(m["temperature"])
        if not 0.0 <= t <= 2.0:
            raise ValueError("temperature must be between 0 and 2")
        out["temperature"] = t
    for price_key in ("input_price", "output_price"):
        if m.get(price_key) is not None:
            v = float(m[price_key])
            if not math.isfinite(v) or v < 0:
                raise ValueError(f"{price_key} must be finite and >= 0")
            out[price_key] = v
    if m.get("thinking") is not None:
        t = str(m["thinking"])
        if t not in THINKING_LEVELS:
            raise ValueError(f"thinking must be one of {THINKING_LEVELS}")
        out["thinking"] = t
    if m.get("supports_images") is not None:
        out["supports_images"] = bool(m["supports_images"])
    if m.get("max_context_length") is not None:
        out["max_context_length"] = int(m["max_context_length"])
        if out["max_context_length"] <= 0:
            raise ValueError("max_context_length must be positive")
    if m.get("auto_compact_threshold") is not None:
        out["auto_compact_threshold"] = int(m["auto_compact_threshold"])
        if out["auto_compact_threshold"] <= 0:
            raise ValueError("auto_compact_threshold must be positive")
    return out


def validate_key(key: str) -> str:
    key = str(key or "").strip()
    if not _KEY_RE.match(key):
        raise ValueError("API key must be a single non-empty token (8+ chars, no whitespace)")
    return key


# ---------------------------------------------------------------- keyring
#
# Thin wrappers so tests can monkeypatch keyring access without touching the
# real system keyring.

def _keyring_set(service: str, username: str, password: str) -> None:
    import keyring  # type: ignore
    keyring.set_password(service, username, password)


def _keyring_get(service: str, username: str) -> Optional[str]:
    import keyring  # type: ignore
    return keyring.get_password(service, username)


def _keyring_delete(service: str, username: str) -> None:
    import keyring  # type: ignore
    from keyring.errors import PasswordDeleteError  # type: ignore
    if _keyring_get(service, username) is None:
        return
    try:
        keyring.delete_password(service, username)
    except PasswordDeleteError:
        if _keyring_get(service, username) is not None:
            raise


def set_provider_key(env_var: str, key: str) -> None:
    """Store a provider key where the vibe CLI will resolve it (live)."""
    _keyring_set(KEYRING_SERVICE, env_var, key)
    for legacy in LEGACY_KEYRING_SERVICES:
        try:
            _keyring_delete(legacy, env_var)
        except Exception:
            pass


def delete_provider_key(env_var: str) -> None:
    for service in (KEYRING_SERVICE, *LEGACY_KEYRING_SERVICES):
        _keyring_delete(service, env_var)


def provider_key_status(env_var: str) -> dict:
    """Key presence + source only — never the key itself.

    Mirrors the vibe CLI's resolution order: environment first, then keyring.
    """
    if not env_var:
        return {"present": False, "source": None}
    if os.environ.get(env_var):
        return {"present": True, "source": "env"}
    from mistral_api import _read_env_file
    if _read_env_file(vibe_config_path().parent / ".env").get(env_var):
        return {"present": True, "source": "file"}
    try:
        if _keyring_get(KEYRING_SERVICE, env_var):
            return {"present": True, "source": "keyring"}
    except Exception:
        pass
    return {"present": False, "source": None}


def provider_key(env_var: str) -> str | None:
    if not env_var:
        return None
    from mistral_api import _read_env_file
    return (os.environ.get(env_var) or _read_env_file(vibe_config_path().parent / ".env").get(env_var)
            or _keyring_get(KEYRING_SERVICE, env_var))


# ---------------------------------------------------------------- view model

def list_providers(path: Optional[Path] = None) -> dict:
    """Full provider view: config + models + key status (no secrets)."""
    path = path or vibe_config_path()
    providers = read_providers(path)
    models = read_models(path)
    out = []
    for p in providers:
        if p["name"] == RESERVED_PROVIDER:
            continue
        env_var = p["api_key_env_var"]
        out.append({
            "name": p["name"],
            "apiBase": p["api_base"],
            "apiStyle": p["api_style"],
            "backend": p["backend"],
            "apiKeyEnvVar": env_var,
            "key": provider_key_status(env_var),
            "models": [m for m in models if m["provider"] == p["name"]],
        })
    # models bound to the built-in provider show under "mistral"
    mistral_models = [m for m in models if m["provider"] == RESERVED_PROVIDER]
    out.insert(0, {
            "name": RESERVED_PROVIDER,
            "apiBase": "https://api.mistral.ai/v1",
            "apiStyle": "openai",
            "backend": "mistral",
            "apiKeyEnvVar": "MISTRAL_API_KEY",
            "key": provider_key_status("MISTRAL_API_KEY"),
            "models": mistral_models,
            "builtin": True,
        })
    worker_models = models or []
    profiles = [{"name": "provider_task", "model": m["alias"]} for m in worker_models]
    if not any(m["model"] == "mistral-large-4" for m in profiles):
        profiles.append({"name": "provider_task", "model": "mistral-large-4"})
    return {"configPath": str(path), "providers": out, "presets": PRESETS, "subagents": profiles}
