"""Queued follow-up messages and forked sessions (fake app-server)."""
import pytest
import vibedeck_server
from fake_bridge import FakeBridge
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as c:
        yield c


def _session(client, cwd):
    before = set(FakeBridge.states)
    r = client.post("/api/sessions", json={"cwd": str(cwd), "lane": "code"})
    assert r.status_code == 200, r.text
    (esid,) = set(FakeBridge.states) - before
    return r.json()["id"], esid


def test_enqueue_starts_when_idle_and_waits_while_running(client, tmp_path):
    sid, esid = _session(client, tmp_path)
    first = client.post(f"/api/sessions/{sid}/queue", json={"text": "go", "requestId": "m1"})
    assert first.status_code == 200, first.text
    assert first.json()["waits"] is False

    waiting = client.post(f"/api/sessions/{sid}/queue", json={"text": "then this", "requestId": "m2"}).json()
    assert waiting["waits"] is True
    queue = client.get(f"/api/sessions/{sid}/queue").json()
    assert [i["id"] for i in queue["items"]] == [waiting["queueItemId"]]
    entry = queue["items"][0]["entries"][0]
    # the request id is the message id, so the queued message can be rewound later
    assert entry == {"role": "user", "content": [{"type": "text", "text": "then this"}], "entryId": "m2"}

    edited = client.put(f"/api/sessions/{sid}/queue/{waiting['queueItemId']}", json={"text": "edited", "requestId": "m3"}).json()
    assert edited["items"][0]["entries"][0]["content"][0]["text"] == "edited"
    assert client.delete(f"/api/sessions/{sid}/queue/{waiting['queueItemId']}").json()["items"] == []


def test_steer_needs_the_running_turn(client, tmp_path):
    sid, esid = _session(client, tmp_path)
    client.post(f"/api/sessions/{sid}/queue", json={"text": "go"})
    item = client.post(f"/api/sessions/{sid}/queue", json={"text": "also"}).json()["queueItemId"]
    assert client.post(f"/api/sessions/{sid}/queue/{item}/steer", json={"expectedTurnId": "stale"}).status_code == 409
    steered = client.post(f"/api/sessions/{sid}/queue/{item}/steer", json={"expectedTurnId": "turn-q"})
    assert steered.status_code == 200 and steered.json()["turnId"] == "turn-q"
    assert client.post(f"/api/sessions/{sid}/queue/resume").json()["items"] == []


def test_queue_rejects_empty_and_bad_images(client, tmp_path):
    sid, _ = _session(client, tmp_path)
    assert client.post(f"/api/sessions/{sid}/queue", json={"text": "  "}).status_code == 400
    bad = {"text": "x", "images": [{"mimeType": "image/bmp", "source": {"kind": "inline", "data": "AA=="}}]}
    assert client.post(f"/api/sessions/{sid}/queue", json=bad).status_code == 400


def test_queue_updates_reach_the_event_stream():
    event = vibedeck_server.normalize_notification(
        {"method": "turn/queueUpdated", "params": {"eventId": 3, "queue": {"items": [], "paused": True}}})
    assert event == {"kind": "queue", "queue": {"items": [], "paused": True}}


def test_fork_creates_a_detached_session(client, tmp_path):
    sid, esid = _session(client, tmp_path)
    FakeBridge.states[esid]["history"] = [
        {"id": "u1", "type": "message", "role": "user", "content": [{"type": "text", "text": "one"}]},
        {"id": "a1", "type": "message", "role": "assistant", "content": [{"type": "text", "text": "ok"}]},
        {"id": "u2", "type": "message", "role": "user", "content": [{"type": "text", "text": "two"}]},
    ]
    r = client.post(f"/api/sessions/{sid}/fork", json={"entryId": "a1"})
    assert r.status_code == 200, r.text
    fork = r.json()
    assert fork["id"] != sid and fork["title"].endswith("(fork)") and fork["cwd"] == str(tmp_path)
    bridge = vibedeck_server.manager.get(sid)
    assert bridge.forks[-1]["attach"] is False and bridge.forks[-1]["entryId"] == "a1"
    assert [e["id"] for e in FakeBridge.states[fork["id"]]["history"]] == ["u1", "a1"]
    assert fork["id"] in {s["id"] for s in client.get("/api/sessions").json()["sessions"]}
    # the source keeps its whole conversation
    assert len(FakeBridge.states[esid]["history"]) == 3


def test_fork_of_unknown_session_is_404(client):
    assert client.post("/api/sessions/nope/fork", json={}).status_code == 404


def test_forking_from_an_untracked_message_explains_why(client, tmp_path):
    from vibe_bridge import BridgeError
    sid, _ = _session(client, tmp_path)
    vibedeck_server.manager.get(sid).failures["session/fork"] = BridgeError(-32603, "Cannot find user entry: user-turn-x-1")
    r = client.post(f"/api/sessions/{sid}/fork", json={"entryId": "user-turn-x-1"})
    assert r.status_code == 409 and "Fork the whole session" in r.json()["detail"]
