import asyncio
import json
import time
from unittest.mock import AsyncMock

import httpx
import providers
import pytest
import usage
import vibedeck_server as server
from fake_bridge import FakeBridge
from fastapi import HTTPException
from fastapi.testclient import TestClient
from store import Store
from vibe_bridge import BridgeError, VibeAppServer


def test_created_at_and_deleted_usage_survive(tmp_path):
    store = Store(tmp_path / "data.db")
    store.upsert_session("a", title="A", created_at=12)
    store.upsert_session("a", title="B")
    assert store.get_session("a")["created_at"] == 12
    store.upsert_costs("a", {"sessionPromptTokens": 100})
    store.delete_session("a")
    assert store.get_costs("a")["prompt_tokens"] == 100


def test_cached_tokens_and_model_changes_do_not_reprice_history(tmp_path):
    store = Store(tmp_path / "data.db")
    store.upsert_costs("s", {})
    stats = {"sessionPromptTokens": 1000, "sessionCompletionTokens": 100, "sessionCachedTokens": 800,
             "inputPricePerMillion": 2, "outputPricePerMillion": 4, "cachedInputPricePerMillion": .5}
    store.upsert_costs("s", stats, "1", "model-a")
    assert store.total_costs()["estimated_cost_usd"] == .0012
    stats.update(sessionPromptTokens=1100, sessionCompletionTokens=110, inputPricePerMillion=10, outputPricePerMillion=20)
    store.upsert_costs("s", stats, "2", "model-b")
    assert store.total_costs()["estimated_cost_usd"] == .0024
    store.upsert_costs("s", stats, "2", "model-b")
    store.upsert_costs("s", stats, "3", "model-b")
    rows = store.usage_activity(0, time.time() + 1)["rows"]
    assert sum(r["prompt_tokens"] for r in rows) == 1100
    assert len(rows) == 2
    # A counter reset starts a new increment without erasing previous spend.
    store.upsert_costs("s", {**stats, "sessionPromptTokens": 100, "sessionCompletionTokens": 10, "sessionCachedTokens": 0}, "4")
    assert store.total_costs()["estimated_cost_usd"] == .0036


def test_old_snapshot_is_not_dated_as_new_activity(tmp_path):
    store = Store(tmp_path / "data.db")
    store.upsert_costs("s", {"sessionPromptTokens": 10000}, "snapshot")
    assert store.usage_activity(0, time.time() + 1)["rows"] == []
    store.record_api_usage("request", "m", {"prompt_tokens": 5, "completion_tokens": 2})
    store.record_api_usage("request", "m", {"prompt_tokens": 5, "completion_tokens": 2})
    assert len(store.usage_activity(0, time.time() + 1)["rows"]) == 1


def test_toml_preserves_nested_unknown_fields_and_rejects_invalid(tmp_path):
    # Fixture-free config includes shapes the old line parser corrupted.
    path = tmp_path / "config.toml"
    path.write_text('''# keep comment
active_model = "local"
[[providers]]
name = 'local'
api_base = "http://localhost:1/v1"
[providers.headers]
custom = "keep"
[[models]]
name = "model"
alias = "local"
provider = "local"
unknown = ["keep", "also"]
[tools.bash]
permission = "ask"
''')
    providers.upsert_provider({"name": "local", "api_base": "http://localhost:2/v1"}, path)
    providers.upsert_model({"name": "model2", "alias": "local", "provider": "local"}, path)
    import tomllib
    parsed = tomllib.loads(path.read_text())
    assert parsed["providers"][0]["headers"] == {"custom": "keep"}
    assert parsed["models"][0]["unknown"] == ["keep", "also"]
    assert parsed["tools"]["bash"]["permission"] == "ask"
    path.write_text("broken = [")
    with pytest.raises(ValueError):
        providers.remove_provider("local", path)
    assert path.read_text() == "broken = ["


@pytest.mark.asyncio
async def test_concurrent_open_spawns_once_and_preserves_effective_id(monkeypatch):
    sid = "legacy"
    server.store.upsert_session(sid, cwd="/tmp", vibe_session_id="unified")
    fake = FakeBridge("/tmp")
    FakeBridge.states["unified"] = {"session": {"id": "unified", "agent": {"name": "ask"}, "model": "m", "status": {"type": "idle"}}}
    spawn = AsyncMock(return_value=fake)
    monkeypatch.setattr(server.manager, "spawn", spawn)
    results = await asyncio.gather(server._ensure_bridge(sid), server._ensure_bridge(sid))
    assert spawn.await_count == 1
    assert [r[1] for r in results] == ["unified", "unified"]
    assert [p["sessionId"] for m, p in fake.calls if m == "session/resume"] == ["unified"]
    assert server.store.get_session(sid)["agent"] == "ask"
    response = await server.release_session(sid)
    assert response["resumeId"] == "unified"
    await asyncio.sleep(0)
    await server._ensure_bridge(sid)
    assert spawn.await_count == 2
    await server.release_session(sid)


@pytest.mark.asyncio
async def test_missing_resume_does_not_create_replacement(monkeypatch):
    server.store.upsert_session("missing", cwd="/tmp")
    fake = FakeBridge("/tmp")
    monkeypatch.setattr(server.manager, "spawn", AsyncMock(return_value=fake))
    with pytest.raises(HTTPException) as error:
        await server._ensure_bridge("missing")
    assert error.value.status_code == 502
    assert not any(m == "session/start" for m, _ in fake.calls)
    assert server.manager.get("missing") is None


@pytest.mark.asyncio
async def test_failure_to_delete_preserves_registry():
    sid = "undeletable"
    fake = FakeBridge("/tmp")
    fake.failures["session/delete"] = BridgeError("permission_denied", "denied")
    server.store.upsert_session(sid, cwd="/tmp")
    server.manager.register(sid, fake)
    with pytest.raises(HTTPException) as error:
        await server.delete_session(sid)
    assert error.value.status_code == 502
    assert server.store.get_session(sid)


@pytest.mark.asyncio
async def test_callback_wire_and_model_rejection(monkeypatch):
    bridge = VibeAppServer("/tmp", server_cmd="fake")
    call = AsyncMock(return_value={})
    monkeypatch.setattr(bridge, "call", call)
    answer = {"answers": [{"question": "Which?", "answer": "A", "isOther": False}], "cancelled": False}
    await bridge.resolve_callback("s", "cb", user_input=answer)
    assert call.call_args.args[1]["result"]["output"] == {"type": "user_input", "result": answer}
    call.return_value = {"rejected": ["model"]}
    with pytest.raises(BridgeError):
        await bridge.set_model("s", "m")


@pytest.mark.asyncio
async def test_cancelled_rpc_removes_pending(monkeypatch):
    bridge = VibeAppServer("/tmp", server_cmd="fake")
    monkeypatch.setattr(bridge, "_send_raw", lambda msg: None)
    task = asyncio.create_task(bridge.call("test"))
    await asyncio.sleep(0)
    assert bridge._pending
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert bridge._pending == {}


@pytest.mark.asyncio
async def test_pagination_and_turn_idempotency(monkeypatch):
    bridge = VibeAppServer("/tmp", server_cmd="fake")
    items = [{"id": str(i)} for i in range(501)]
    call = AsyncMock(side_effect=[{"items": items[:500], "nextCursor": "next"}, {"items": items[500:]}])
    monkeypatch.setattr(bridge, "call", call)
    assert await bridge.list_sessions(500) == items
    assert call.call_args.args[1]["cursor"] == "next"
    call.side_effect = None
    call.return_value = {}
    await bridge.send_turn("s", "hello", request_id="retry-1")
    assert call.call_args.args[1]["idempotencyKey"] == "retry-1"


def test_config_validates_batch_before_writing_and_clears_reasoning():
    with TestClient(server.app, base_url="http://127.0.0.1:9377") as client:
        before = client.get("/api/config").json()
        result = client.patch("/api/config", json={"defaultModel": "bad", "defaultAgent": "ask"})
        assert result.status_code == 400
        assert client.get("/api/config").json()["defaultAgent"] == before["defaultAgent"]
        assert client.patch("/api/config", json={"defaultReasoning": "high"}).status_code == 200
        assert client.patch("/api/config", json={"defaultReasoning": None}).json()["defaultReasoning"] is None
        assert client.get("/api/usage?month=0").status_code == 400


def billing_fixture():
    scope = {"event_type": "chat", "billing_metric": "tokens", "billing_group": "input", "api_zone": "eu", "service_tier": "standard"}
    return {"start_date": "2026-10-01", "end_date": "2026-11-01", "currency": "USD",
        "completion": {"models": {"m": {"input": [{**scope, "timestamp": "2026-10-09T00:00:00Z", "value": 1000, "value_paid": 800}]}}},
        "prices": [{**scope, "price": "0.000002"}]}


def test_billing_units_and_missing_prices():
    data = billing_fixture()
    result = usage.normalize_billing(data, "admin")
    assert result["cost"] == pytest.approx(.0016)
    assert result["inputTokens"] == 1000
    # A price from another zone/tier must never be applied.
    data["prices"][0]["api_zone"] = "us"
    assert usage.normalize_billing(data, "admin")["cost"] is None
    data["prices"][0].pop("api_zone")
    data["prices"][0].pop("service_tier")
    assert usage.normalize_billing(data, "admin")["cost"] == pytest.approx(.0016)


@pytest.mark.asyncio
async def test_usage_coalesces_requests_and_preserves_stale(monkeypatch):
    reader = usage.UsageReader()
    monkeypatch.setattr(usage, "_admin_key", lambda: "test-admin")
    monkeypatch.setattr(usage, "cli_key", lambda: None)
    monkeypatch.setattr(reader, "_cli_account", AsyncMock(return_value={"status": "disconnected"}))
    requests = []
    fail = False
    async def get(client, url, **kwargs):
        requests.append(url)
        if fail:
            raise httpx.ConnectError("offline")
        return httpx.Response(200, json=billing_fixture() if "usage" in url else {"limits": {}}, request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.AsyncClient, "get", get)
    a, b = await asyncio.gather(reader.read(2026, 10), reader.read(2026, 10))
    assert a == b
    assert len(requests) == 2
    fail = True
    for value in reader._cache.values():
        value["_fetched"] -= 301
    stale = await reader.read(2026, 10, True)
    assert stale["billing"]["status"] == "stale"
    assert stale["billing"]["cost"] == pytest.approx(.0016)
    assert "test-admin" not in json.dumps(stale)


@pytest.mark.asyncio
async def test_cli_plan_uses_console_account_endpoint(monkeypatch, tmp_path):
    monkeypatch.setenv("VIBE_HOME", str(tmp_path))
    monkeypatch.setenv("MISTRAL_API_KEY", "cli-key-example-1234")
    (tmp_path / "config.toml").write_text('vibe_base_url = "https://chat.example"\n')
    urls = []

    async def get(_client, url, **kwargs):
        urls.append(url)
        return httpx.Response(200, json={"plan_name": "INDIVIDUAL", "plan_type": "individual"},
                              request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", get)
    assert (await usage.UsageReader()._cli_account())["plan"] == "INDIVIDUAL"
    assert urls == ["https://console.mistral.ai/api/vibe/whoami"]
    (tmp_path / "config.toml").write_text('console_base_url = "https://tenant.example"\n')
    await usage.UsageReader()._cli_account()
    assert urls[-1] == "https://tenant.example/api/vibe/whoami"


@pytest.mark.asyncio
async def test_cli_plan_reads_key_scoped_cache(monkeypatch, tmp_path):
    import hashlib
    key = "cli-key-example-1234"
    monkeypatch.setenv("VIBE_HOME", str(tmp_path))
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    (tmp_path / ".env").write_text(f'MISTRAL_API_KEY="{key}"\n')
    (tmp_path / "whoami_cache.json").write_text(json.dumps({hashlib.sha256(key.encode()).hexdigest()[:32]: {
        "stored_at_timestamp": time.time(), "payload": {"plan_name": "Pro", "plan_type": "pro"}}}))
    account = await usage.UsageReader()._cli_account()
    assert account["plan"] == "Pro"
    assert key not in json.dumps(account)


@pytest.mark.asyncio
async def test_http_retry_uses_saved_result_without_replaying_native_turn():
    sid = "retry-safe"
    bridge = FakeBridge("/tmp")
    await bridge.start_session()
    server.store.upsert_session(sid, cwd="/tmp", status="idle")
    server.manager.register(sid, bridge)
    request = server.TurnReq(text="One message", requestId="same-request")
    first = await server.send_turn(sid, request)
    assert await server.send_turn(sid, request) == first
    assert len([m for m, _ in bridge.calls if m == "turn/start"]) == 1
    with pytest.raises(HTTPException) as error:
        await server.send_turn(sid, server.TurnReq(text="Different", requestId="same-request"))
    assert error.value.status_code == 409
    await server.manager.close(sid)


@pytest.mark.asyncio
async def test_sse_snapshot_watermark_and_cleanup():
    sid = "stream-safe"
    bridge = FakeBridge("/tmp")
    await bridge.start_session()
    native = bridge.session_id
    FakeBridge.states[native].update(eventId=5, history=[{"id": "old", "type": "message"}])
    server.store.upsert_session(sid, cwd="/tmp", status="idle")
    server.manager.register(sid, bridge)
    response = await server.stream_events(sid)
    iterator = response.body_iterator
    first = await anext(iterator)
    assert '"id": "old"' in first
    assert '"lastEventId": 5' in first
    queue = bridge._subscribers[-1]
    queue.put_nowait({"method": "history/entryAdded", "params": {"eventId": 4, "entry": {"id": "duplicate"}}})
    queue.put_nowait({"method": "history/entryAdded", "params": {"eventId": 6, "entry": {"id": "new"}}})
    event = await anext(iterator)
    assert '"id": "new"' in event and "duplicate" not in event
    await iterator.aclose()
    assert not bridge._subscribers
    await server.manager.close(sid)


@pytest.mark.asyncio
async def test_tap_overflow_reconciles_without_clearing_running_status():
    sid = "tap-recovery"
    bridge = FakeBridge("/tmp")
    await bridge.start_session()
    FakeBridge.states[bridge.session_id]["session"]["status"] = {"type": "running"}
    server.store.upsert_session(sid, cwd="/tmp", status="running")
    server.manager.register(sid, bridge)
    server._start_tap(sid, bridge)
    old = server._taps[sid]
    bridge._tap_queues[0].put_nowait(None)
    await old
    assert server.store.get_session(sid)["status"] == "running"
    assert server._taps[sid] is not old
    assert len(bridge._tap_queues) == 1
    await server.manager.close(sid)
    await server._stop_tap(sid)
