"""Vibe Code Web teleport through the sidecar (fake app-server, no network)."""
import time

import pytest
import vibedeck_server
from fastapi.testclient import TestClient
from vibe_bridge import BridgeError


@pytest.fixture(scope="module")
def client():
    # one portal for the module so teleport watcher tasks outlive a request
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as c:
        yield c


def _session(client):
    r = client.post("/api/sessions", json={"cwd": "/tmp", "lane": "code"})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _wait(client, sid, op, until):
    for _ in range(100):
        d = client.get(f"/api/sessions/{sid}/cloud/teleport/{op}").json()
        if until(d):
            return d
        time.sleep(0.02)
    raise AssertionError(f"teleport stuck at {d}")


def test_teleport_pushes_with_approval_and_returns_cloud_url(client):
    sid = _session(client)
    opened = client.post(f"/api/sessions/{sid}/cloud/open", json={}).json()
    assert opened["pickerId"] == "picker-1"
    assert opened["view"]["state"]["projects"][0]["projectId"] == "p1"
    assert client.post(f"/api/sessions/{sid}/cloud/projects/select", json={"pickerId": "picker-1", "projectId": "p1"}).status_code == 200

    started = client.post(f"/api/sessions/{sid}/cloud/teleport", json={"pickerId": "picker-1", "projectId": "p1", "prompt": "finish the tests"})
    assert started.status_code == 200, started.text
    op = started.json()["operationId"]
    d = _wait(client, sid, op, lambda d: d["push"] is not None)
    assert d["push"] == {"unpushedCount": 2, "branchNotPushed": False}
    assert [e["kind"] for e in d["events"]] == ["summarizing_context", "checking_git", "push_required"]

    assert client.post(f"/api/sessions/{sid}/cloud/teleport/{op}/push", json={"approved": True}).status_code == 200
    d = _wait(client, sid, op, lambda d: d["done"])
    assert d["status"] == "complete" and d["url"] == "https://chat.mistral.ai/code/s/123" and d["push"] is None
    assert client.post(f"/api/sessions/{sid}/cloud/teleport/{op}/push", json={"approved": True}).status_code == 409


def test_declined_push_fails_and_cancel_is_idempotent(client):
    sid = _session(client)
    client.post(f"/api/sessions/{sid}/cloud/open", json={})
    op = client.post(f"/api/sessions/{sid}/cloud/teleport", json={"pickerId": "picker-1", "projectId": "p1"}).json()["operationId"]
    _wait(client, sid, op, lambda d: d["push"] is not None)
    client.post(f"/api/sessions/{sid}/cloud/teleport/{op}/push", json={"approved": False})
    d = _wait(client, sid, op, lambda d: d["done"])
    assert d["status"] == "failed" and d["error"] == "Push was declined."
    assert client.post(f"/api/sessions/{sid}/cloud/teleport/{op}/cancel").json()["status"] == "failed"


def test_cancel_running_teleport(client):
    sid = _session(client)
    client.post(f"/api/sessions/{sid}/cloud/open", json={})
    op = client.post(f"/api/sessions/{sid}/cloud/teleport", json={"pickerId": "picker-1", "projectId": "p1"}).json()["operationId"]
    _wait(client, sid, op, lambda d: d["push"] is not None)
    d = client.post(f"/api/sessions/{sid}/cloud/teleport/{op}/cancel").json()
    assert d["status"] == "cancelled" and d["done"] and d["push"] is None


def test_create_project_selects_it(client):
    sid = _session(client)
    client.post(f"/api/sessions/{sid}/cloud/open", json={})
    r = client.post(f"/api/sessions/{sid}/cloud/projects/create", json={"pickerId": "picker-1", "name": "New one", "defaultBranch": "main"})
    assert r.status_code == 200 and r.json()["project"]["projectId"] == "p2"


def test_access_errors_surface_as_conflicts(client):
    sid = _session(client)
    bridge = vibedeck_server.manager.get(sid)
    bridge.failures["vibeCode/projects/open"] = BridgeError("forbidden", "Teleport requires an active Mistral model.")
    r = client.post(f"/api/sessions/{sid}/cloud/open", json={})
    assert r.status_code == 409 and "Mistral model" in r.json()["detail"]
    assert client.get(f"/api/sessions/{sid}/cloud/teleport/nope").status_code == 404
    for bad in [{}, {"pickerId": ""}, {"pickerId": "x", "projectId": ""}]:
        assert client.post(f"/api/sessions/{sid}/cloud/teleport", json=bad).status_code == 422
