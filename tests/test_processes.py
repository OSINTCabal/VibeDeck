"""Subagents, background processes and ! shell commands (fake app-server)."""
import pytest
import vibedeck_server
from fake_bridge import FakeBridge
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as c:
        yield c


@pytest.fixture
def sid(client, tmp_path):
    FakeBridge.subagents = [
        {"sessionId": "c1", "parentSessionId": "s", "rootSessionId": "s", "name": "explore", "spawnActionId": "a1",
         "status": "running", "usage": {"totalTokens": 1200}, "costUsd": 0.01},
        {"sessionId": "c2", "parentSessionId": "s", "rootSessionId": "s", "name": "review", "spawnActionId": "a2", "status": "idle"},
    ]
    yield client.post("/api/sessions", json={"cwd": str(tmp_path), "lane": "code"}).json()["id"]
    FakeBridge.subagents = []


def test_subagents_list_and_interrupt(client, sid):
    names = [a["name"] for a in client.get(f"/api/sessions/{sid}/subagents").json()["subagents"]]
    assert names == ["explore", "review"]
    results = client.post(f"/api/sessions/{sid}/subagents/interrupt", json={}).json()["results"]
    assert results == [{"sessionId": "c1", "name": "explore", "outcome": "interrupted"}]
    assert client.post(f"/api/sessions/{sid}/subagents/interrupt", json={"reason": ""}).status_code == 422


def test_background_processes_and_output(client, sid):
    procs = client.get(f"/api/sessions/{sid}/background").json()["processes"]
    assert procs[0]["processId"] == "p1" and procs[0]["command"] == "npm run dev"
    out = client.get(f"/api/sessions/{sid}/background/p1/output").json()
    assert out["available"] and out["text"] == "line 1\nline 2\n" and out["nextCursor"] == 14
    assert client.get(f"/api/sessions/{sid}/background/gone/output").json() == {"available": False}
    assert client.post(f"/api/sessions/{sid}/background/p1/stop").json()["status"] == "stopped"


def test_shell_command_starts_and_can_be_interrupted(client, sid):
    r = client.post(f"/api/sessions/{sid}/shell", json={"command": "git status"})
    assert r.status_code == 200, r.text
    op = r.json()["operationId"]
    bridge = vibedeck_server.manager.get(sid)
    assert bridge.shell[-1] == {"sessionId": bridge.session_id, "command": "git status", "operationId": op, "timeoutSeconds": 120.0}
    assert client.post(f"/api/sessions/{sid}/shell/{op}/interrupt").json() == {"ok": True}


def test_shell_refusals_come_back(client, sid):
    assert client.post(f"/api/sessions/{sid}/shell", json={"command": "fail now"}).status_code == 409
    assert client.post(f"/api/sessions/{sid}/shell", json={"command": ""}).status_code == 422
    assert client.post(f"/api/sessions/{sid}/shell", json={"command": "x", "timeoutSeconds": 900}).status_code == 422
