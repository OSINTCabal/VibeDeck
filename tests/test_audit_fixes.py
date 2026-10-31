import asyncio
from unittest.mock import AsyncMock, Mock

import providers
import pytest
import vibedeck_server as server
from fastapi import HTTPException
from fastapi.testclient import TestClient
from store import Store
from vibe_sessions import VibeSessionSync


@pytest.mark.parametrize("host", ["evil.example:9377", "localhost.evil:9377", "127.0.0.1:80", "user@localhost:9377", "[broken"])
def test_foreign_hosts_cannot_mutate_sessions(host, monkeypatch):
    release = AsyncMock()
    monkeypatch.setattr(server.manager, "close", release)
    with TestClient(server.app, base_url="http://127.0.0.1:9377") as client:
        assert client.post("/api/sessions/fixture/release", headers={"Host": host}).status_code == 400
        release.assert_not_awaited()


@pytest.mark.parametrize("origin", ["https://evil.example", "null", "", "http://localhost:8000"])
def test_foreign_origins_cannot_mutate_sessions(origin):
    with TestClient(server.app, base_url="http://127.0.0.1:9377") as client:
        assert client.post("/api/sessions/fixture/release", headers={"Origin": origin}).status_code == 403


def test_local_browser_and_native_requests_keep_authentication():
    with TestClient(server.app, base_url="http://127.0.0.1:9377") as client:
        assert client.get("/api/config").status_code == 200
        for origin in server.LOCAL_ORIGINS:
            assert client.get("/api/config", headers={"Origin": origin}).status_code == 200
        assert client.get("/api/config", headers={"Host": "localhost:5173"}).status_code == 200
        assert client.get("/api/codex/v1/models").status_code == 401


@pytest.mark.parametrize("source", ["invalid", 123, True, ["inline"], None, {}])
def test_malformed_image_sources_never_reach_a_bridge(source, monkeypatch):
    ensure = AsyncMock()
    monkeypatch.setattr(server, "_ensure_bridge", ensure)
    with TestClient(server.app, base_url="http://127.0.0.1:9377") as client:
        response = client.post("/api/sessions/fixture/turns", json={
            "text": "image", "images": [{"source": source, "mimeType": "image/png"}]})
        assert response.status_code == 400
        ensure.assert_not_awaited()


@pytest.mark.asyncio
async def test_registry_refreshes_after_external_cli_edits(tmp_path, monkeypatch):
    """Registry reads share the host bridge, which restarts when Vibe's
    configuration changes, so an external CLI edit is picked up."""
    import vibe_sessions
    from fake_bridge import FakeBridge
    config = tmp_path / "config.toml"
    monkeypatch.setattr(providers, "vibe_config_path", lambda: config)
    await server.manager.close(server.LISTER_KEY)
    starts = []
    monkeypatch.setattr(vibe_sessions, "VibeAppServer", lambda **kw: starts.append(kw) or FakeBridge(**kw))
    before = await server._read_vibe_models()
    await server._read_vibe_models()
    assert len(starts) == 1
    providers.upsert_provider({"name": "local", "api_base": "http://localhost:11434/v1"}, config)
    providers.upsert_model({"name": "model-b", "alias": "audit-b", "provider": "local"}, config)
    after = await server._read_vibe_models()
    assert "audit-b" not in {m["id"] for m in before}
    assert "audit-b" in {m["id"] for m in after}
    assert len(starts) == 2
    # agents read from the same, still current bridge, then from the cache
    await server._read_agents()
    await server._read_agents()
    assert len(starts) == 2
    (tmp_path / "agents").mkdir()
    (tmp_path / "agents" / "new.toml").write_text('name = "new"\n')
    await server._read_agents()
    assert len(starts) == 3


@pytest.mark.asyncio
async def test_registry_survives_a_restart_until_the_config_changes(tmp_path, monkeypatch):
    config = tmp_path / "config.toml"
    monkeypatch.setattr(providers, "vibe_config_path", lambda: config)
    providers.upsert_model({"name": "m", "alias": "saved-model", "provider": "mistral"}, config)
    first = await server._read_vibe_models()
    assert "saved-model" in {m["id"] for m in first}
    # a new sidecar process: empty memory cache, no running app-server
    server._vibe_models_cache = None
    await server.manager.close(server.LISTER_KEY)
    read = AsyncMock(side_effect=AssertionError("must not start Vibe"))
    monkeypatch.setattr(server.vsync, "host", read)
    assert await server._read_vibe_models() == first
    # an in-process invalidation drops the saved copy too
    server._invalidate_vibe_models()
    assert server._saved_registry("models", server._registry_signature()) is None


@pytest.mark.asyncio
async def test_invalidation_during_registry_probe_cannot_restore_old_cache(monkeypatch):
    bridge = await server.vsync.host(server._registry_signature())
    original = bridge.read_config
    async def read():
        data = await original()
        server._invalidate_vibe_models()
        return data
    monkeypatch.setattr(bridge, "read_config", read)
    assert await server._read_vibe_models()
    assert server._vibe_models_cache is None


@pytest.mark.asyncio
async def test_provider_reload_waits_for_idle_session(monkeypatch):
    created = await server.create_session(server.SessionCreate(cwd="/tmp"))
    sid = created["id"]
    bridge = server.manager.get(sid)
    reload = AsyncMock(return_value={})
    monkeypatch.setattr(bridge, "reload_config", reload)
    monkeypatch.setattr(providers, "sync_subagents", lambda: None)
    server.store.upsert_session(sid, status="running")
    await server._providers_changed()
    await server._ensure_bridge(sid)
    reload.assert_not_awaited()
    changes = sum(method == "session/agent/update" for method, _ in bridge.calls)
    with pytest.raises(HTTPException) as error:
        await server.patch_session(sid, server.SessionPatch(agent="ask"))
    assert error.value.status_code == 409
    assert sum(method == "session/agent/update" for method, _ in bridge.calls) == changes
    server.store.upsert_session(sid, status="idle")
    await server._ensure_bridge(sid)
    await server._ensure_bridge(sid)
    reload.assert_awaited_once()
    await server.release_session(sid)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_unknown_session_reloads_config_after_confirming_idle(monkeypatch):
    created = await server.create_session(server.SessionCreate(cwd="/tmp"))
    sid = created["id"]
    bridge = server.manager.get(sid)
    reload = AsyncMock(return_value={})
    monkeypatch.setattr(bridge, "reload_config", reload)
    server._stale_config.add(sid)
    server.store.upsert_session(sid, status="unknown")
    await server.send_turn(sid, server.TurnReq(text="Explicit next message", requestId="fresh-request"))
    reload.assert_awaited_once()
    assert sum(method == "turn/start" for method, _ in bridge.calls) == 1
    await server.manager.close(sid)
    await server._stop_tap(sid)


@pytest.mark.asyncio
async def test_unchanged_cli_sessions_do_not_write_sqlite(tmp_path, monkeypatch):
    store = Store(tmp_path / "data.db")
    sync = VibeSessionSync(store, server.manager)
    items = {str(i): {"id": str(i), "title": "CLI session", "cwd": "/tmp",
                      "model": "m", "agent": "ask", "status": {"type": "idle"}} for i in range(500)}
    for sid, item in items.items():
        store.upsert_session(sid, **sync._row_fields(sid, item, None))
    monkeypatch.setattr(sync, "refresh", AsyncMock(return_value=items))
    write = Mock(wraps=store.upsert_session)
    monkeypatch.setattr(store, "upsert_session", write)
    await sync.sync()
    write.assert_not_called()
    items["1"]["title"] = "Renamed in CLI"
    items["2"]["title"] = "Desktop owns this"
    await sync.sync(live_sids={"2"})
    write.assert_called_once()
    assert store.get_session("1")["title"] == "Renamed in CLI"
    assert store.get_session("2")["title"] == "CLI session"
