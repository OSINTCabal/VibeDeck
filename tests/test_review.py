"""Reviewing agent changes and rewinding a conversation (fake app-server)."""
import pytest
import vibedeck_server
from fake_bridge import FakeBridge
from fastapi.testclient import TestClient
from review import anchor_hunks, diff_rows


@pytest.fixture(scope="module")
def client():
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as c:
        yield c


@pytest.fixture(autouse=True)
def clean_review():
    FakeBridge.review = {}
    yield
    FakeBridge.review = {}


def _session(client, cwd):
    before = set(FakeBridge.states)
    r = client.post("/api/sessions", json={"cwd": str(cwd), "lane": "code"})
    assert r.status_code == 200, r.text
    (esid,) = set(FakeBridge.states) - before
    return r.json()["id"], esid


AGENT = {"kind": "agent", "turnId": 1}


def _pending(path):
    region = {"kind": "text", "versionIndex": 0, "ordinal": 0, "owner": AGENT, "baselineStart": 1,
              "baselineLineCount": 1, "currentStart": 1, "currentLineCount": 1, "decision": "pending", "dependsOn": []}
    return {"files": [{"path": path, "status": "modified", "regions": [region]}],
            "scopes": [{"owner": AGENT, "files": [{"path": path, "status": "modified", "regionCount": 1}]}]}


def test_diff_rows_collapse_unchanged_runs():
    base = "".join(f"line {i}\n" for i in range(20))
    cur = base.replace("line 10\n", "line ten\n")
    rows = diff_rows(base, cur)
    assert rows[0] == {"t": "skip", "count": 7}
    assert [r["t"] for r in rows[1:]] == ["ctx"] * 3 + ["del", "add"] + ["ctx"] * 3 + ["skip"]
    assert rows[4] == {"t": "del", "old": 10, "text": "line 10"}
    assert rows[5] == {"t": "add", "new": 10, "text": "line ten"}
    assert rows[-1] == {"t": "skip", "count": 6}
    hunks = anchor_hunks(rows, [{"side": "additions", "line": 10, "regions": []},
                                {"side": "deletions", "line": 10, "regions": []}])
    # both anchor above the change block, at its first deleted line
    assert [h["row"] for h in hunks] == [4, 4]


def test_diff_rows_created_and_short_files():
    assert diff_rows("", "a\nb") == [{"t": "add", "new": 0, "text": "a"}, {"t": "add", "new": 1, "text": "b"}]
    assert [r["t"] for r in diff_rows("a\nb\nc\n", "a\nB\nc\n")] == ["ctx", "del", "add", "ctx"]


def test_whole_file_diff_reads_disk_and_anchors_hunks(client, tmp_path):
    (tmp_path / "a.py").write_text("one\nTWO\nthree\n")
    sid, _ = _session(client, tmp_path)
    path = str(tmp_path / "a.py")
    FakeBridge.review = {"state": _pending(path), "baseline": "one\ntwo\nthree\n",
                         "hunks": [{"side": "additions", "line": 1, "regions": [{"versionIndex": 0, "ordinal": 0}]}]}
    state = client.get(f"/api/sessions/{sid}/review").json()
    assert state["files"][0]["path"] == path and state["cwd"] == str(tmp_path)

    d = client.get(f"/api/sessions/{sid}/review/file", params={"path": path}).json()
    assert [r["t"] for r in d["rows"]] == ["ctx", "del", "add", "ctx"]
    assert d["rows"][2]["text"] == "TWO"
    assert d["hunks"][0]["row"] == 1  # above the block, at its deleted line

    # only paths the review lists can be read
    assert client.get(f"/api/sessions/{sid}/review/file", params={"path": "/etc/passwd"}).status_code == 404


def test_turn_diff_uses_the_scope(client, tmp_path):
    sid, _ = _session(client, tmp_path)
    path = str(tmp_path / "b.py")
    FakeBridge.review = {"state": _pending(path), "turnDiff": {"status": "created", "baseline": "", "current": "x\n"}}
    d = client.get(f"/api/sessions/{sid}/review/file", params={"path": path, "owner": "agent:1"}).json()
    assert d["status"] == "created" and d["rows"] == [{"t": "add", "new": 0, "text": "x"}]
    assert client.get(f"/api/sessions/{sid}/review/file", params={"path": path, "owner": "agent:2"}).status_code == 404
    assert client.get(f"/api/sessions/{sid}/review/file", params={"path": path, "owner": "bogus"}).status_code == 400


def test_approve_and_revert_forward_validated_targets(client, tmp_path):
    sid, _ = _session(client, tmp_path)
    FakeBridge.review = {"state": _pending("a.py")}
    r = client.post(f"/api/sessions/{sid}/review/revert",
                    json={"target": {"kind": "regions", "path": "a.py", "regions": [{"versionIndex": 0, "ordinal": 0}]}})
    assert r.status_code == 200, r.text
    assert r.json()["files"] == []
    assert client.post(f"/api/sessions/{sid}/review/approve", json={"target": {"kind": "scope", "owner": AGENT}}).status_code == 200
    assert client.post(f"/api/sessions/{sid}/review/approve", json={"target": {"kind": "all"}}).status_code == 200
    assert FakeBridge.review["decisions"] == [
        ("review/revert", {"kind": "regions", "path": "a.py", "regions": [{"versionIndex": 0, "ordinal": 0}]}),
        ("review/approve", {"kind": "scope", "owner": AGENT}),
        ("review/approve", {"kind": "all"}),
    ]
    for bad in ({"kind": "nope"}, {"kind": "region", "path": "a.py"}, {"kind": "all", "extra": 1},
                {"kind": "lastTurns", "count": 0}):
        assert client.post(f"/api/sessions/{sid}/review/approve", json={"target": bad}).status_code == 422
    assert client.post(f"/api/sessions/{sid}/review/delete", json={"target": {"kind": "all"}}).status_code == 422


def test_rewind_returns_the_message_and_restores_on_request(client, tmp_path):
    sid, esid = _session(client, tmp_path)
    FakeBridge.states[esid]["history"] = [
        {"id": "u1", "type": "message", "role": "user", "content": [{"type": "text", "text": "first"}]},
        {"id": "a1", "type": "message", "role": "assistant", "content": [{"type": "text", "text": "ok"}]},
        {"id": "u2", "type": "message", "role": "user", "content": [{"type": "text", "text": "second"}]},
    ]
    preview = client.get(f"/api/sessions/{sid}/rewind/u2").json()
    assert preview["hasFileChanges"] is True

    r = client.post(f"/api/sessions/{sid}/rewind/u2", json={"restoreFiles": True})
    assert r.status_code == 200, r.text
    assert r.json() == {"message": "second", "restoredPaths": [f"{tmp_path}/a.py"], "restoreErrors": []}
    assert [e["id"] for e in FakeBridge.states[esid]["history"]] == ["u1", "a1"]

    assert client.post(f"/api/sessions/{sid}/rewind/a1", json={}).status_code == 409
    assert client.post(f"/api/sessions/{sid}/rewind/u1", json={"restoreFiles": "yes"}).status_code == 422


def test_turns_carry_a_client_message_id_for_rewind(client, tmp_path):
    sid, esid = _session(client, tmp_path)
    r = client.post(f"/api/sessions/{sid}/turns", json={"text": "hi", "requestId": "req-123"})
    assert r.status_code == 200, r.text
    bridge = vibedeck_server.manager.get(sid)
    start = next(p for m, p in bridge.calls if m == "turn/start")
    assert start["clientUserMessageId"] == "req-123"
    client.post(f"/api/sessions/{sid}/interrupt", params={"turn_id": r.json()["turn"]["id"]})


def test_rewinding_an_untracked_message_explains_why(client, tmp_path):
    sid, _ = _session(client, tmp_path)
    bridge = vibedeck_server.manager.get(sid)
    from vibe_bridge import BridgeError
    bridge.failures["session/rewind"] = BridgeError(-32603, "Cannot find user entry: user-turn-abc-1")
    r = client.post(f"/api/sessions/{sid}/rewind/user-turn-abc-1", json={})
    assert r.status_code == 409 and "before VibeDeck recorded message ids" in r.json()["detail"]
