"""MCP servers, connectors, the skill registry, loops and dictation (fake app-server)."""
import extensions
import httpx
import pytest
import vibedeck_server
from fake_bridge import FakeBridge
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as c:
        yield c


@pytest.fixture(autouse=True)
def catalog(monkeypatch):
    FakeBridge.extensions = {}
    monkeypatch.setattr(extensions, "_factory", lambda cwd: FakeBridge(cwd))
    monkeypatch.setattr(extensions, "_bridge", None)
    monkeypatch.setattr(extensions, "_session", None)
    yield
    FakeBridge.extensions = {}


def test_mcp_sources_come_from_an_ephemeral_catalog_session(client):
    d = client.get("/api/extensions/mcp").json()
    assert [s["name"] for s in d["sources"]] == ["github", "notion"]
    start = next(p for m, p in extensions._bridge.calls if m == "session/start")
    assert start["kind"] == "ephemeral"
    # one catalog session serves later calls too
    client.get("/api/extensions/mcp")
    assert sum(m == "session/start" for m, _ in extensions._bridge.calls) == 1


def test_toggle_add_and_remove_servers(client):
    d = client.post("/api/extensions/mcp/toggle", json={"name": "github", "source": "server", "disabled": True}).json()
    assert d["sources"][0]["status"] == "disabled"
    added = client.post("/api/extensions/mcp/add", json={"name": "docs", "url": "https://mcp.example/sse", "transport": "sse"}).json()
    assert added["created"] and "docs" in [s["name"] for s in added["sources"]]
    added_params = {k: v for k, v in FakeBridge.extensions["added"].items() if k != "sessionId"}
    assert added_params == {"transport": "sse", "url": "https://mcp.example/sse", "allowInsecureHttp": False, "name": "docs"}
    local = client.post("/api/extensions/mcp/add", json={"transport": "stdio", "command": "npx", "args": ["-y", "srv"]})
    assert local.status_code == 200
    assert client.post("/api/extensions/mcp/add", json={"transport": "stdio"}).status_code == 400
    assert client.post("/api/extensions/mcp/add", json={"url": "ftp://x"}).status_code == 400
    left = client.post("/api/extensions/mcp/remove", json={"name": "docs"}).json()
    assert "docs" not in [s["name"] for s in left["sources"]]


def test_login_returns_the_browser_link(client):
    assert client.post("/api/extensions/mcp/login", json={"name": "github"}).json() == {"url": "https://auth.example/github"}
    assert client.post("/api/extensions/mcp/login", json={"name": "notion", "source": "connector"}).json() == {
        "url": "https://mistral.example/connect/notion"}


def test_skill_registry_install_update_toggle_remove(client):
    d = client.get("/api/extensions/skills").json()
    assert d["catalog"][0]["skillId"] == "sk1" and d["updates"] == {}
    assert [s["name"] for s in d["installed"]] == ["local-one"]
    d = client.post("/api/extensions/skills/install", json={"skillId": "sk1"}).json()
    assert "reviewer" in [s["name"] for s in d["installed"]] and d["updates"] == {"reviewer": 2}
    client.post("/api/extensions/skills/update", json={"name": "reviewer"})
    client.post("/api/extensions/skills/enabled", json={"name": "reviewer", "enabled": False})
    d = client.post("/api/extensions/skills/remove", json={"name": "reviewer"}).json()
    assert [m for m, _ in FakeBridge.extensions["skill_calls"]] == ["skills/setLatest", "skills/setEnabled", "skills/remove"]
    assert "reviewer" not in [s["name"] for s in d["installed"]]


def test_loops(client, tmp_path):
    sid = client.post("/api/sessions", json={"cwd": str(tmp_path), "lane": "code"}).json()["id"]
    d = client.post(f"/api/sessions/{sid}/loops", json={"interval": "10m", "prompt": "check CI"}).json()
    assert d["loops"][0]["prompt"] == "check CI"
    assert client.post(f"/api/sessions/{sid}/loops", json={"interval": "soon", "prompt": "x"}).status_code == 422
    assert client.delete(f"/api/sessions/{sid}/loops/l1").json() == {"loops": []}


def test_dictation_sends_the_recording_to_voxtral(client, monkeypatch):
    monkeypatch.setenv("MISTRAL_API_KEY", "k" * 32)
    seen = {}

    async def post(self, url, headers=None, data=None, files=None):
        seen.update(url=url, data=data, file=files["file"])
        return httpx.Response(200, json={"text": " hello there "})
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    r = client.post("/api/voice/transcribe?language=fr-FR", content=b"RIFFdata", headers={"Content-Type": "audio/webm;codecs=opus"})
    assert r.status_code == 200, r.text
    assert r.json() == {"text": "hello there"}
    assert seen["url"].endswith("/audio/transcriptions") and seen["data"] == {"model": "voxtral-mini-latest", "language": "fr"}
    assert seen["file"] == ("dictation.webm", b"RIFFdata", "audio/webm")
    # Voxtral has no Ukrainian hint: it detects the language itself
    client.post("/api/voice/transcribe?language=uk", content=b"x", headers={"Content-Type": "audio/webm"})
    assert seen["data"] == {"model": "voxtral-mini-latest"}
    assert client.post("/api/voice/transcribe", content=b"x", headers={"Content-Type": "text/plain"}).status_code == 400
    assert client.post("/api/voice/transcribe", content=b"", headers={"Content-Type": "audio/webm"}).status_code == 400


def test_dictation_needs_a_key(client):
    r = client.post("/api/voice/transcribe", content=b"x", headers={"Content-Type": "audio/webm"})
    assert r.status_code == 400 and "API key" in r.json()["detail"]
