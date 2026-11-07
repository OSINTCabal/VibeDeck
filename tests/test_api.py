"""API tests for the VibeDeck sidecar (FastAPI TestClient, isolated temp DB)."""
import pytest
import vibedeck_server
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    # Context-manager form: one portal (one event loop) for the whole module.
    # Without it, each request gets a fresh loop and any bridge spawned during
    # a request has its reader task cancelled when that request's portal exits.
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as c:
        yield c


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    d = r.json()
    assert d["ok"] is True
    assert d["default_model"] == "mistral-large-4"
    assert d["default_agent"] == "accept-edits"


def test_config_get_patch(client):
    r = client.get("/api/config")
    assert r.status_code == 200
    d = r.json()
    assert d["defaultModel"] == "mistral-large-4"
    assert "ask" in d["agentModes"]
    assert "max" in d["reasoningLevels"]

    r = client.patch("/api/config", json={"defaultAgent": "plan"})
    assert r.status_code == 200
    assert r.json()["defaultAgent"] == "plan"
    # restore
    client.patch("/api/config", json={"defaultAgent": "accept-edits"})

    # invalid agent rejected
    r = client.patch("/api/config", json={"defaultAgent": "bogus"})
    assert r.status_code == 400


def test_sessions_empty_list(client):
    r = client.get("/api/sessions")
    assert r.status_code == 200
    # The registry mirrors the shared vibe CLI session store, so a fresh
    # sidecar may legitimately list pre-existing CLI sessions — just check
    # the endpoint answers with a well-formed list.
    sessions = r.json()["sessions"]
    assert isinstance(sessions, list)
    for s in sessions:
        assert s["id"] and s["title"]


def test_session_not_found(client):
    r = client.get("/api/sessions/does-not-exist")
    assert r.status_code == 404


def test_delete_missing_session_404(client):
    r = client.delete("/api/sessions/does-not-exist")
    assert r.status_code == 404


def test_unknown_api_route_404(client):
    """Unknown /api/* paths 404 as JSON — they must not fall through to the
    SPA catch-all and return index.html with a 200."""
    r = client.get("/api/definitely-not-a-route")
    assert r.status_code == 404
    assert "unknown API route" in r.json()["detail"]
    r = client.post("/api/definitely-not-a-route")
    assert r.status_code == 404


def test_config_vibe_models(client):
    """config exposes the vibe CLI's model aliases (for session model pickers)."""
    from vibe_bridge import find_app_server
    r = client.get("/api/config")
    assert r.status_code == 200
    assert "vibeModels" in r.json()
    try:
        find_app_server()
    except FileNotFoundError:
        pytest.skip("vibe-app-server not installed")
    models = r.json()["vibeModels"]
    assert isinstance(models, list) and len(models) > 0
    assert any(m["id"] == "mistral-large-4" for m in models)


def test_patch_session_bad_model_502(client):
    """An unknown model alias must surface the app-server's error, not a 500,
    and must leave the stored model unchanged."""
    from vibe_bridge import find_app_server
    try:
        find_app_server()
    except FileNotFoundError:
        pytest.skip("vibe-app-server not installed")
    r = client.post("/api/sessions", json={"cwd": "/tmp", "lane": "code"})
    assert r.status_code == 200
    sid = r.json()["id"]
    try:
        r = client.patch(f"/api/sessions/{sid}", json={"model": "not-a-real-model"})
        assert r.status_code == 502
        assert "not-a-real-model" in r.json()["detail"]
        # stored model unchanged
        cur = client.get(f"/api/sessions/{sid}").json()
        assert cur["model"] == "mistral-large-4"
    finally:
        client.delete(f"/api/sessions/{sid}")


def test_create_session_bad_cwd(client):
    r = client.post("/api/sessions", json={"cwd": "/no/such/dir/here", "lane": "code"})
    assert r.status_code == 400


def test_create_session_bad_agent(client):
    r = client.post("/api/sessions", json={"cwd": "/tmp", "agent": "bogus", "lane": "code"})
    assert r.status_code == 400


def test_create_session_bad_lane(client):
    r = client.post("/api/sessions", json={"cwd": "/tmp", "lane": "chat"})
    assert r.status_code == 400


def test_api_key_endpoints(client, tmp_path, monkeypatch):
    """Add/remove the API key at will; the key value is never echoed back."""
    import mistral_api
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr(mistral_api, "_keyring_key", lambda: None)

    key = "aB3" * 12

    r = client.get("/api/settings/api-key")
    assert r.status_code == 200
    d = r.json()
    assert d["present"] is False and d["source"] is None
    assert key not in r.text

    # invalid keys are rejected
    r = client.put("/api/settings/api-key", json={"key": "no"})
    assert r.status_code == 400

    # add
    r = client.put("/api/settings/api-key", json={"key": key})
    assert r.status_code == 200
    d = r.json()
    assert d["present"] is True and d["source"] == "file"
    assert key not in r.text  # never echoed back
    h = client.get("/api/health").json()
    assert h["api_key"] is True and h["api_key_source"] == "file"

    # remove
    r = client.delete("/api/settings/api-key")
    assert r.status_code == 200
    d = r.json()
    assert d["present"] is False and d["source"] == "disabled"
    h = client.get("/api/health").json()
    assert h["api_key"] is False

    # add again after remove
    r = client.put("/api/settings/api-key", json={"key": key})
    assert r.status_code == 200
    assert r.json()["present"] is True


def test_worktrees_endpoint(client):
    """Regression: get_worktrees unpacked _ensure_bridge's tuple and 500'd."""
    from vibe_bridge import find_app_server
    try:
        find_app_server()
    except FileNotFoundError:
        pytest.skip("vibe-app-server not installed")
    r = client.post("/api/sessions", json={"cwd": "/tmp", "lane": "code"})
    assert r.status_code == 200
    sid = r.json()["id"]
    try:
        r = client.get(f"/api/worktrees?sid={sid}")
        assert r.status_code == 200
    finally:
        client.delete(f"/api/sessions/{sid}")


def test_skills(client):
    r = client.get("/api/skills")
    assert r.status_code == 200
    d = r.json()
    assert "skills" in d and "dir" in d


def test_mcp(client):
    r = client.get("/api/mcp")
    assert r.status_code == 200
    assert "servers" in r.json()


def test_agents(client):
    r = client.get("/api/agents")
    assert r.status_code == 200
    assert "agents" in r.json()


def test_audit(client):
    r = client.get("/api/audit")
    assert r.status_code == 200
    assert "audit" in r.json()


def test_studio_costs(client):
    r = client.get("/api/studio/costs")
    assert r.status_code == 200
    assert "total" in r.json()


def test_studio_models(client, monkeypatch):
    from unittest.mock import AsyncMock
    monkeypatch.setattr(vibedeck_server, "resolve_api_key", lambda: "test-key")
    monkeypatch.setattr(vibedeck_server, "list_models", AsyncMock(return_value=[{"id": "mistral-large-4"}]))
    r = client.get("/api/studio/models")
    assert r.status_code == 200
    models = r.json()["models"]
    assert any(m["id"] == "mistral-large-4" for m in models)


def test_projects(client, tmp_path, monkeypatch):
    """Project candidates: home + existing conventional dirs; recents from sessions."""
    import vibedeck_server
    monkeypatch.setattr(vibedeck_server.Path, "home", lambda: tmp_path)
    (tmp_path / "Documents").mkdir()
    (tmp_path / "Code").mkdir()
    (tmp_path / "NotAProject").mkdir()  # not in the conventional list
    r = client.get("/api/projects")
    assert r.status_code == 200
    d = r.json()
    assert d["home"] == str(tmp_path)
    known = {p["name"] for p in d["known"]}
    assert known == {"Documents", "Code"}
    # recents derive from the session registry, which mirrors the shared
    # vibe CLI store — check the shape, not emptiness
    assert isinstance(d["recent"], list)
    for r in d["recent"]:
        assert set(r) == {"path", "name", "lastUsed"}
