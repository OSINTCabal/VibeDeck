"""Vibe Code Web session parsing (fixtures shaped like chat.mistral.ai's tRPC responses)."""
import json
import subprocess

import cloud_sessions
import pytest
import vibedeck_server
from cloud_sessions import CloudError
from fastapi.testclient import TestClient

P = "01a18c97-dee3-728a-9ff8-03c99699c97d"
S = "01a18e10-cc12-776d-aa3d-8da71cc7c513"


def batch(value):
    return json.dumps([{"result": {"data": {"json": value, "meta": {"values": {}, "v": 1}}}}])


def trpc_error(code, http):
    return json.dumps([{"error": {"json": {"message": code.title(), "code": -32001,
                                           "data": {"code": code, "httpStatus": http, "path": "sessions.list"}}}}])


PROJECTS = {"items": [
    {"id": P, "name": "dual-my-sense", "repositories": [
        {"id": "r1", "repoUrl": "https://github.com/Mallar2d/dual-my-sense", "defaultBranch": "main", "provider": "github"}],
     "isReadOnly": False},
    {"id": "p-empty", "name": " ", "repositories": []},
    {"name": "no id"},
], "nextCursor": None}

SESSIONS = {"items": [
    {"id": "old", "projectId": P, "title": "дорожня карта проекту", "status": "blocked", "isArchived": False,
     "isUnseen": True, "pinnedAt": None, "createdAt": "2026-10-30T11:35:40.625Z", "bumpedAt": "2026-10-30T11:38:28.513Z"},
    {"id": S, "projectId": P, "title": "Оновлення інтерфейсу", "status": "blocked", "isArchived": False,
     "isUnseen": False, "pinnedAt": None, "createdAt": "2026-10-30T18:27:07.921Z", "bumpedAt": "2026-10-30T18:44:41.487Z"},
    {"id": "gone", "projectId": P, "title": "Archived", "isArchived": True, "createdAt": "2026-10-29T00:00:00Z"},
    {"id": "blank", "title": None, "createdAt": "bad date"},
], "nextCursor": "c2"}

MESSAGES = {"messages": [
    {"id": "a1", "sessionId": S, "turn": 1, "role": "assistant", "status": "complete", "createdAt": "2026-10-30T20:12:35.714Z",
     "contentChunks": [{"type": "text", "text": "Second answer"}]},
    {"id": "u1", "sessionId": S, "turn": 1, "role": "user", "status": "complete", "createdAt": "2026-10-30T18:44:41.591Z",
     "contentChunks": [{"type": "text", "text": "Можеш показати що вийшло?"}]},
    {"id": "a0", "sessionId": S, "turn": 0, "role": "assistant", "status": "complete", "createdAt": "2026-10-30T18:44:27.407Z",
     "contentChunks": [
         {"type": "tool_call", "toolType": "raw", "id": "progress", "name": "Preparing environment", "isDone": True,
          "success": True, "startTime": 1000, "endTime": 8000, "publicArguments": "setup_startup_ready"},
         {"type": "text", "text": "Thinking it over", "_context": {"type": "reasoning", "startTime": 9000, "endTime": 12000}},
         {"type": "text", "text": "Checking the tools."},
         {"type": "tool_call", "toolType": "raw", "id": "t1", "name": "bash", "isDone": True, "startTime": 13000, "endTime": 14000,
          "publicArguments": {"type": "tool", "content": "$ ls", "toolUIState": {"type": "command"}},
          "publicResult": json.dumps({"id": "t1", "input": {"command": "ls -la\necho done", "timeout_seconds": 300},
                                      "output": {"status": "completed", "value": {"stdout": "a\nb", "stderr": "", "returncode": 0}}})},
         {"type": "tool_call", "toolType": "raw", "id": "t2", "name": "read_file", "isDone": True, "isInterrupted": False,
          "publicArguments": {"path": "/w/src/main.rs"},
          "publicResult": json.dumps({"id": "t2", "input": {"path": "/w/src/main.rs"},
                                      "output": {"status": "failed", "error": "not found"}})},
         {"type": "tool_call", "toolType": "raw", "id": "t3", "name": "grep", "isDone": False,
          "publicArguments": {"pattern": "egui", "path": "/w"}, "publicResult": "{not json"},
         {"type": "task_callback", "callbackName": "ask_user_question",
          "input": {"questions": [{"question": "Which theme?", "options": ["Dark", "Light"]}]},
          "result": {"status": "submitted", "value": ["Dark"]}},
         {"type": "text", "text": "Done."},
         {"type": "mystery"},
     ]},
    {"id": "u0", "sessionId": S, "turn": 0, "role": "user", "status": "complete", "createdAt": "2026-10-30T18:27:09.443Z",
     "contentChunks": [{"type": "text", "text": "Онови інтерфейс"}]},
    {"id": "sys", "role": "system", "contentChunks": []},
], "nextCursor": None}


def test_unwrap_maps_upstream_failures():
    assert cloud_sessions.unwrap(200, batch({"items": []})) == {"items": []}
    cases = [
        (0, "", "offline"),
        (401, trpc_error("UNAUTHORIZED", 401), "signed_out"),
        (404, trpc_error("NOT_FOUND", 404), "not_found"),
        (500, trpc_error("INTERNAL_SERVER_ERROR", 500), "unavailable"),
        (403, "<!DOCTYPE html><html><title>Just a moment...</title>", "blocked"),
        (502, "Bad gateway", "unavailable"),
        (200, "[1]", "unavailable"),
    ]
    for status, text, code in cases:
        with pytest.raises(CloudError) as raised:
            cloud_sessions.unwrap(status, text)
        assert raised.value.code == code, (status, text)


@pytest.mark.parametrize("url", [
    "https://github.com/mallar2d/dual-my-sense",
    "https://github.com/Mallar2D/dual-my-sense.git",
    "git@github.com:mallar2d/dual-my-sense.git",
    "ssh://git@github.com:22/mallar2d/dual-my-sense",
    "https://user@github.com/mallar2d/dual-my-sense/",
])
def test_repo_key_normalizes_remote_forms(url):
    assert cloud_sessions.repo_key(url) == "github.com/mallar2d/dual-my-sense"


def test_repo_key_rejects_non_repositories():
    assert cloud_sessions.repo_key("") is None
    assert cloud_sessions.repo_key("https://github.com/") is None
    assert cloud_sessions.repo_key("/home/me/repo") is None


def test_projects_parse_and_match_local_repositories():
    projects, cursor = cloud_sessions.parse_projects(cloud_sessions.unwrap(200, batch(PROJECTS)))
    assert cursor is None
    assert [p["name"] for p in projects] == ["dual-my-sense", "Untitled project"]
    assert projects[0]["url"] == f"https://chat.mistral.ai/code/{P}"
    matched = cloud_sessions.match_local(projects, [
        ("/home/me/other", ["git@github.com:me/other.git"]),
        ("/home/me/dms", ["git@github.com:mallar2d/dual-my-sense.git"]),
        ("/home/me/dms-copy", ["https://github.com/mallar2d/dual-my-sense"]),
    ])
    assert [p["localPath"] for p in matched] == ["/home/me/dms", None]


def test_git_remote_urls_reads_config_and_worktrees(tmp_path):
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "remote", "add", "origin", "git@github.com:me/repo.git"], check=True)
    subprocess.run(["git", "-C", str(repo), "remote", "add", "fork", "https://github.com/fork/repo"], check=True)
    assert cloud_sessions.git_remote_urls(repo, repo / ".git") == ["git@github.com:me/repo.git", "https://github.com/fork/repo"]
    subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], check=True)
    subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", str(tmp_path / "wt")], check=True)
    import git_projects
    wt = tmp_path / "wt"
    assert cloud_sessions.git_remote_urls(wt, git_projects.git_dir(wt))[0] == "git@github.com:me/repo.git"
    assert cloud_sessions.git_remote_urls(tmp_path, None) == []


def test_sessions_parse_newest_first_without_archived():
    sessions, cursor = cloud_sessions.parse_sessions(cloud_sessions.unwrap(200, batch(SESSIONS)), P)
    assert cursor == "c2"
    assert [s["id"] for s in sessions] == [S, "old", "blank"]
    first = sessions[0]
    assert first["title"] == "Оновлення інтерфейсу" and first["projectId"] == P and first["status"] == "blocked"
    assert first["url"] == f"https://chat.mistral.ai/code/{P}/{S}"
    assert first["updatedAt"] > first["createdAt"] > 0
    assert sessions[1]["unseen"] is True
    assert sessions[2]["title"] == "Untitled session" and sessions[2]["projectId"] == P


def test_messages_become_history_entries_in_turn_order():
    entries, cursor = cloud_sessions.parse_messages(cloud_sessions.unwrap(200, batch(MESSAGES)), S)
    assert cursor is None
    kinds = [(e["type"], e.get("role") or e.get("title")) for e in entries]
    assert kinds == [
        ("message", "user"), ("effect", "Preparing environment"), ("reasoning", None), ("message", "assistant"),
        ("effect", "bash"), ("effect", "read_file"), ("effect", "grep"), ("message", "assistant"), ("message", "assistant"),
        ("message", "user"), ("message", "assistant"),
    ]
    assert entries[0]["content"][0]["text"] == "Онови інтерфейс"
    assert all(e["sessionId"] == S for e in entries) and len({e["id"] for e in entries}) == len(entries)
    setup, reasoning, _, bash, read, grep, question = entries[1:8]
    assert setup["detail"]["display"]["summary"] == "setup_startup_ready" and setup["state"]["status"] == "completed"
    assert reasoning["text"] == "Thinking it over" and reasoning["updatedAt"] - reasoning["createdAt"] == 3000
    assert bash["detail"]["input"]["command"].startswith("ls -la") and bash["detail"]["display"]["summary"] == "ls -la"
    assert bash["state"] == {"status": "completed", "outputText": "a\nb"}
    assert read["state"] == {"status": "failed", "outputText": "not found"}
    assert grep["state"]["status"] == "running" and grep["detail"]["input"] == {"pattern": "egui", "path": "/w"}
    assert "**Which theme?**" in question["content"][0]["text"] and "Answer: Dark" in question["content"][0]["text"]
    assert entries[8]["content"][0]["text"] == "Done."


def test_long_tool_output_is_clipped():
    chunk = {"type": "tool_call", "name": "bash", "isDone": True,
             "publicResult": json.dumps({"input": {"command": "x" * 30000}, "output": {"status": "completed", "value": "y" * 30000}})}
    entries, _ = cloud_sessions.parse_messages({"messages": [{"id": "m", "role": "assistant", "turn": 0, "contentChunks": [chunk]}]}, S)
    state, detail = entries[0]["state"], entries[0]["detail"]
    assert len(state["outputText"]) < 20100 and state["outputText"].endswith("(truncated)")
    assert isinstance(detail["input"], str) and detail["input"].endswith("(truncated)")


def test_unexpected_shapes_raise():
    for parse in (cloud_sessions.parse_projects, lambda d: cloud_sessions.parse_sessions(d, P),
                  lambda d: cloud_sessions.parse_messages(d, S)):
        with pytest.raises(CloudError):
            parse({"something": "else"})


def test_endpoints_parse_and_report_errors(monkeypatch):
    async def remotes():
        return [("/home/me/dms", ["https://github.com/mallar2d/dual-my-sense.git"])]
    monkeypatch.setattr(vibedeck_server, "_local_repo_remotes", remotes)
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as client:
        r = client.post("/api/cloud/projects", json={"status": 200, "text": batch(PROJECTS)})
        assert r.status_code == 200 and r.json()["projects"][0]["localPath"] == "/home/me/dms"
        r = client.post("/api/cloud/sessions", json={"status": 200, "text": batch(SESSIONS), "projectId": P})
        assert [s["id"] for s in r.json()["sessions"]][:1] == [S]
        r = client.post("/api/cloud/messages", json={"status": 200, "text": batch(MESSAGES), "sessionId": S})
        assert r.json()["entries"][0]["role"] == "user"
        r = client.post("/api/cloud/sessions", json={"status": 401, "text": trpc_error("UNAUTHORIZED", 401), "projectId": P})
        assert r.json() == {"error": {"code": "signed_out", "message": "Sign in to Mistral to see your Vibe Code Web sessions."}}
        assert client.post("/api/cloud/messages", json={"status": 0, "text": "", "sessionId": S}).json()["error"]["code"] == "offline"
        assert client.post("/api/cloud/messages", json={"status": 200, "text": "{}"}).status_code == 422


def test_session_state_and_write_results():
    state = cloud_sessions.parse_session(cloud_sessions.unwrap(200, batch(
        {"id": S, "status": "active", "waitKind": None, "title": "Оновлення інтерфейсу"})))
    assert state == {"id": S, "status": "active", "waitKind": None, "title": "Оновлення інтерфейсу", "active": True}
    blocked = cloud_sessions.parse_session({"id": S, "status": "blocked", "waitKind": "question", "title": " "})
    assert blocked["active"] is False and blocked["waitKind"] == "question" and blocked["title"] is None
    with pytest.raises(CloudError):
        cloud_sessions.parse_session({"status": "active"})
    assert cloud_sessions.parse_result(cloud_sessions.unwrap(200, batch(None))) == {"ok": True}
    busy = json.dumps([{"error": {"json": {"message": "Session already has an active turn", "code": -32009,
                                           "data": {"code": "CONFLICT", "httpStatus": 409}}}}])
    with pytest.raises(CloudError) as raised:
        cloud_sessions.unwrap(409, busy)
    assert raised.value.code == "rejected" and raised.value.message.endswith("Session already has an active turn")
    with pytest.raises(CloudError) as raised:
        cloud_sessions.unwrap(400, trpc_error("BAD_REQUEST", 400).replace('"Bad_Request"', '"Bad request"'))
    assert raised.value.code == "rejected"


def test_pending_callbacks_become_answer_cards():
    def callback(name, data, status="pending"):
        return {"type": "task_callback", "callbackId": "cb-" + name, "callbackName": name, "input": data,
                "result": {"status": status} if status != "submitted" else {"status": status, "value": {"confirmation": "allow"}}}
    chunks = [
        callback("ask_user_question", {"questions": [{"question": "Which theme?", "options": ["Dark", "Light"]}]}),
        callback("ask_user_confirmation", {"taskName": "push_branch", "taskInput": {}, "taskCallId": "t", "confirmationReason": "Pushes to GitHub"}),
        callback("ask_user_permission", {"effect": {"summary": "rm -rf build"}, "options": [{"id": "allow_once", "label": "Allow once"}, {"id": "deny", "label": "Deny"}]}),
        callback("ask_enable_connector", {"connectorIds": ["github"]}),
        callback("ask_user_confirmation", {"taskName": "deploy"}, status="submitted"),
        {"type": "task_callback", "callbackName": "ask_user_question", "input": {}, "result": {"status": "pending"}},
    ]
    entries, _ = cloud_sessions.parse_messages({"messages": [
        {"id": "m", "role": "assistant", "turn": 0, "status": "generating", "contentChunks": [
            {"type": "text", "text": "Hmm", "_context": {"type": "reasoning", "startTime": 5}}, *chunks]}]}, S)
    reasoning, question, confirm, permission, connector, answered = entries
    assert reasoning["generationStatus"] == "in_progress"
    assert question["type"] == "callback" and question["callbackId"] == "cb-ask_user_question"
    assert question["state"] == {"status": "open"} and question["detail"]["kind"] == "user_input"
    assert question["detail"]["request"]["questions"] == [{"question": "Which theme?", "hideOther": False,
                                                           "options": [{"label": "Dark"}, {"label": "Light"}]}]
    assert confirm["detail"] == {"kind": "approval", "cloudCallback": "ask_user_confirmation", "choices": ["approve", "deny"], "reason": "Pushes to GitHub"}
    assert confirm["title"] == "push_branch"
    assert permission["title"] == "rm -rf build" and permission["detail"]["choices"] == ["allow_once", "deny"]
    assert permission["detail"]["labels"] == {"allow_once": "Allow once", "deny": "Deny"}
    assert connector["type"] == "message" and "Enable it on chat.mistral.ai" in connector["content"][0]["text"]
    assert answered["type"] == "message" and "**Approval:** deploy" in answered["content"][0]["text"] and "Answer: allow" in answered["content"][0]["text"]


def test_session_and_result_endpoints():
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as client:
        r = client.post("/api/cloud/session", json={"status": 200, "text": batch({"id": S, "status": "active"})})
        assert r.json()["session"]["active"] is True
        assert client.post("/api/cloud/result", json={"status": 200, "text": batch({})}).json() == {"ok": True}
        assert client.post("/api/cloud/result", json={"status": 0, "text": ""}).json()["error"]["code"] == "offline"
