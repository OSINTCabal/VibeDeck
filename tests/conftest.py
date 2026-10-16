import os
import sys
import tempfile
from pathlib import Path

import pytest

# Point VibeDeck's data dir at a temp location BEFORE the server module is imported,
# so the module-level Store/Manager use an isolated DB.
_TMP = tempfile.mkdtemp(prefix="vibedeck-test-")
os.environ["VIBEDECK_DATA"] = _TMP
os.environ.setdefault("VIBEDECK_PORT", "9377")
os.environ["VIBE_HOME"] = str(Path(_TMP) / "vibe")
os.environ["XDG_CONFIG_HOME"] = str(Path(_TMP) / "config")
Path(os.environ["VIBE_HOME"]).mkdir()
(Path(os.environ["VIBE_HOME"]) / "agents").mkdir()
for name in ("codex", "agy"):
    (Path(os.environ["VIBE_HOME"]) / "agents" / f"{name}.toml").write_text(f'name = "{name}"\n')

# Make the sidecar package importable.
SIDECAR = Path(__file__).resolve().parent.parent / "sidecar"
sys.path.insert(0, str(SIDECAR))


@pytest.fixture(autouse=True)
def isolated_runtime(monkeypatch, request):
    if request.node.get_closest_marker("integration"):
        return
    import httpx
    import mistral_api
    import providers
    import usage
    import vibedeck_server as server
    from fake_bridge import FakeBridge

    FakeBridge.states.clear()
    server._vibe_models_cache = None
    server._agents_cache = None
    server.vsync._last_refresh = 0
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    monkeypatch.delenv("MISTRAL_ADMIN_API_KEY", raising=False)
    monkeypatch.setattr(mistral_api, "_keyring_key", lambda: None)
    monkeypatch.setattr(usage, "_keyring_key", lambda: None)
    monkeypatch.setattr(providers, "_keyring_get", lambda *args: None)
    monkeypatch.setattr(server, "find_app_server", lambda: "mock-vibe-app-server")

    async def spawn(cwd, key=None):
        return FakeBridge(cwd)
    monkeypatch.setattr(server.manager, "spawn", spawn)
    import vibe_sessions
    monkeypatch.setattr(vibe_sessions, "VibeAppServer", FakeBridge)

    # A guard makes accidentally introduced external HTTP fail immediately.
    async def no_network(*args, **kwargs):
        raise AssertionError("Unit tests must not make external HTTP requests")
    monkeypatch.setattr(httpx.AsyncClient, "send", no_network)
