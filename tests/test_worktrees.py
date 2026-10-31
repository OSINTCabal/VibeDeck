"""Worktree sessions, worktree housekeeping and context compaction (fake app-server)."""
import pytest
import vibedeck_server
from fake_bridge import FakeBridge
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as c:
        yield c


def _repo(tmp_path):
    (tmp_path / ".git").mkdir()
    return tmp_path


def test_session_in_a_new_worktree_works_there(client, tmp_path):
    repo = _repo(tmp_path)
    r = client.post("/api/sessions", json={"cwd": str(repo), "lane": "code", "worktree": True})
    assert r.status_code == 200, r.text
    assert r.json()["cwd"] == str(repo / ".vibe-worktrees" / "brave-otter")
    bridge = vibedeck_server.manager.get(r.json()["id"])
    start = next(p for m, p in bridge.calls if m == "session/start")
    assert start["agentConfig"] == {"worktree": {"kind": "auto"}}


def test_worktree_needs_a_repository(client, tmp_path):
    r = client.post("/api/sessions", json={"cwd": str(tmp_path), "lane": "code", "worktree": True})
    assert r.status_code == 400 and "worktree" in r.json()["detail"]
    # a plain session never asks for one
    plain = client.post("/api/sessions", json={"cwd": str(tmp_path), "lane": "code"}).json()
    assert "agentConfig" not in next(p for m, p in vibedeck_server.manager.get(plain["id"]).calls if m == "session/start")


def test_worktree_listing_covers_session_repositories(client, tmp_path):
    repo = _repo(tmp_path)
    client.post("/api/sessions", json={"cwd": str(repo), "lane": "code"})
    d = client.get("/api/worktrees/all").json()
    assert str(repo) in d["repositories"]
    wt = next(w for w in d["worktrees"] if w["repoRoot"] == str(repo))
    assert wt["branch"] == "vibe/brave-otter" and wt["branchChanges"] == {"additions": 3, "deletions": 1}


def test_worktree_remove_prune_and_limit(client):
    assert client.post("/api/worktrees/remove", json={"cwd": "/w/clean"}).json()["outcome"] == "removed"
    kept = client.post("/api/worktrees/remove", json={"cwd": "/w/dirty"}).json()
    assert kept["outcome"] == "kept_dirty" and kept["reasons"]
    assert client.post("/api/worktrees/remove", json={"cwd": "/w/dirty", "force": True}).json()["outcome"] == "removed"
    assert client.post("/api/worktrees/remove", json={"cwd": "/w/dirty", "force": "yes"}).status_code == 422
    assert client.post("/api/worktrees/prune").json() == {"removed": 2}
    assert client.put("/api/worktrees/limit", json={"limit": 5}).json()["limit"] == 5
    assert client.put("/api/worktrees/limit", json={"limit": 101}).status_code == 422


def test_compact_returns_the_summary_and_announces_it(client, tmp_path):
    sid = client.post("/api/sessions", json={"cwd": str(tmp_path), "lane": "code"}).json()["id"]
    r = client.post(f"/api/sessions/{sid}/compact", json={"instructions": "keep the test names"})
    assert r.status_code == 200, r.text
    assert r.json() == {"summary": "We fixed the tests."}
    call = next(p for m, p in vibedeck_server.manager.get(sid).calls if m == "session/compact")
    assert call["extraInstructions"] == "keep the test names"
    event = vibedeck_server.normalize_notification({"method": "session/compacted", "params": {
        "eventId": 9, "summaryLength": 42, "state": FakeBridge.states[call["sessionId"]]}})
    assert event["kind"] == "snapshot" and event["compacted"] is True
    assert event["history"][0]["id"] == "summary"
