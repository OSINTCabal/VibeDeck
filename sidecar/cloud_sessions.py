"""Vibe Code Web ("cloud") sessions.

Mistral serves sessions only to the signed-in web app (``/api/code-trpc/*``
behind Cloudflare), so the Electron shell reads and writes them from a page
in the workspace partition and hands the raw tRPC responses to the sidecar.
This module turns those responses into VibeDeck's shapes: cloud projects
matched to local repositories, session rows and live state, and history
entries the conversation view already renders, open questions included.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional

WEB_BASE = "https://chat.mistral.ai/code"
MAX_TEXT = 20_000


class CloudError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def unwrap(status: int, text: str) -> Any:
    """The ``json`` value of a single tRPC batch result, or a CloudError."""
    if status == 0:
        raise CloudError("offline", "Mistral is unreachable. Check your connection and try again.")
    try:
        body = json.loads(text)
    except (TypeError, ValueError):
        body = None
    if body is None:
        if status in (401, 403) or "<html" in (text or "")[:500].lower():
            raise CloudError("blocked", "Mistral asked for a browser check. Open Vibe Code on chat.mistral.ai, then refresh.")
        raise CloudError("unavailable", f"Vibe Code Web returned HTTP {status}.")
    item = body[0] if isinstance(body, list) and body else body
    if not isinstance(item, dict):
        raise CloudError("unavailable", "Vibe Code Web returned an unexpected response.")
    error = item.get("error")
    if error is not None or status != 200:
        data = ((error or {}).get("json") or {}).get("data") or {} if isinstance(error, dict) else {}
        code, http = data.get("code"), data.get("httpStatus", status)
        if code == "UNAUTHORIZED" or http == 401 or status == 401:
            raise CloudError("signed_out", "Sign in to Mistral to see your Vibe Code Web sessions.")
        if code == "NOT_FOUND" or http == 404:
            raise CloudError("not_found", "This cloud session no longer exists.")
        if code in ("BAD_REQUEST", "CONFLICT", "PRECONDITION_FAILED", "UNPROCESSABLE_CONTENT", "TOO_MANY_REQUESTS"):
            message = ((error or {}).get("json") or {}).get("message") if isinstance(error, dict) else None
            useful = isinstance(message, str) and message and message != "Bad request"
            raise CloudError("rejected", f"Vibe Code Web declined the request: {message}" if useful else "Vibe Code Web declined the request.")
        raise CloudError("unavailable", f"Vibe Code Web returned HTTP {http}.")
    data = (item.get("result") or {}).get("data")
    if not isinstance(data, dict):
        raise CloudError("unavailable", "Vibe Code Web returned an unexpected response.")
    return data.get("json", data)


# ---- repositories

_SCP = re.compile(r"^(?:[\w.-]+@)?([\w.-]+):(?!//)(.+)$")


def repo_key(url: str) -> Optional[str]:
    """``host/owner/name`` for any https, ssh or scp-style git URL."""
    if not isinstance(url, str) or not url.strip():
        return None
    url = url.strip()
    match = re.match(r"^[a-z][a-z0-9+.-]*://(?:[^@/]+@)?([^/:]+)(?::\d+)?/(.+)$", url, re.I)
    if not match:
        match = _SCP.match(url)
    if not match:
        return None
    host, path = match.group(1).lower(), match.group(2).strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        return None
    return "/".join([host, *parts]).lower()


def git_remote_urls(repo: Path, git_dir: Optional[Path]) -> list[str]:
    """Remote URLs from the repository's config file, without running git."""
    if git_dir is None:
        return []
    config = git_dir / "config"
    try:
        common = (git_dir / "commondir").read_text(encoding="utf-8").strip()
        config = (git_dir / common / "config") if common else config
    except OSError:
        pass
    try:
        text = config.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    urls, in_remote = [], False
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("["):
            in_remote = line.startswith("[remote ")
        elif in_remote and line.split("=", 1)[0].strip().lower() == "url" and "=" in line:
            urls.append(line.split("=", 1)[1].strip())
    return urls


def parse_projects(data: Any) -> tuple[list[dict], Optional[str]]:
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise CloudError("unavailable", "Vibe Code Web returned an unexpected project list.")
    projects = []
    for row in items:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
            continue
        repos = []
        for repo in row.get("repositories") or []:
            if not isinstance(repo, dict) or not isinstance(repo.get("repoUrl"), str):
                continue
            repos.append({"url": repo["repoUrl"], "key": repo_key(repo["repoUrl"]),
                          "branch": repo.get("defaultBranch") if isinstance(repo.get("defaultBranch"), str) else None})
        name = row.get("name") if isinstance(row.get("name"), str) and row["name"].strip() else "Untitled project"
        projects.append({"id": row["id"], "name": name, "repos": repos, "localPath": None,
                         "url": f"{WEB_BASE}/{row['id']}"})
    cursor = data.get("nextCursor")
    return projects, cursor if isinstance(cursor, str) and cursor else None


def match_local(projects: list[dict], candidates: Iterable[tuple[str, list[str]]]) -> list[dict]:
    """Set ``localPath`` to the first local repository sharing a remote.

    ``candidates`` are ``(path, remote_urls)`` pairs in preference order.
    """
    by_key: dict[str, str] = {}
    for path, urls in candidates:
        for url in urls:
            key = repo_key(url)
            if key and key not in by_key:
                by_key[key] = path
    for project in projects:
        project["localPath"] = next((by_key[r["key"]] for r in project["repos"] if r["key"] in by_key), None)
    return projects


# ---- sessions

def _seconds(value: Any) -> Optional[float]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def parse_sessions(data: Any, project_id: str) -> tuple[list[dict], Optional[str]]:
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise CloudError("unavailable", "Vibe Code Web returned an unexpected session list.")
    sessions = []
    for row in items:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"] or row.get("isArchived") is True:
            continue
        pid = row.get("projectId") if isinstance(row.get("projectId"), str) else project_id
        created = _seconds(row.get("createdAt")) or 0
        title = row.get("title") if isinstance(row.get("title"), str) and row["title"].strip() else "Untitled session"
        sessions.append({
            "id": row["id"], "projectId": pid, "title": title.strip(),
            "status": row.get("status") if isinstance(row.get("status"), str) else "unknown",
            "createdAt": created, "updatedAt": _seconds(row.get("bumpedAt")) or created,
            "unseen": row.get("isUnseen") is True, "pinned": bool(row.get("pinnedAt")),
            "url": f"{WEB_BASE}/{pid}/{row['id']}",
        })
    sessions.sort(key=lambda s: s["updatedAt"], reverse=True)
    cursor = data.get("nextCursor")
    return sessions, cursor if isinstance(cursor, str) and cursor else None


def parse_session(data: Any) -> dict:
    """Live state from ``sessions.byId``: whether a turn runs and what it waits for."""
    if not isinstance(data, dict) or not isinstance(data.get("id"), str):
        raise CloudError("unavailable", "Vibe Code Web returned an unexpected session.")
    status = data.get("status") if isinstance(data.get("status"), str) else "unknown"
    wait = data.get("waitKind") if data.get("waitKind") in ("question", "approval", "idle") else None
    title = data.get("title") if isinstance(data.get("title"), str) and data["title"].strip() else None
    return {"id": data["id"], "status": status, "waitKind": wait, "title": title, "active": status == "active"}


def parse_result(data: Any) -> dict:
    """A write went through; its payload is not needed."""
    return {"ok": True}


# ---- transcript

def _clip(text: str) -> str:
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + "\n… (truncated)"


def _ms(value: Any, fallback: float) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 else fallback


def _tool_output(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        streams = [value.get(k) for k in ("stdout", "stderr") if isinstance(value.get(k), str) and value.get(k)]
        if streams:
            return "\n".join(streams)
        for key in ("content", "output", "message", "result"):
            if isinstance(value.get(key), str):
                return value[key]
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return str(value)


def _tool_entry(chunk: dict, base: dict, at: float) -> dict:
    name = chunk.get("name") if isinstance(chunk.get("name"), str) and chunk["name"] else "tool"
    args = chunk.get("publicArguments")
    result: dict = {}
    if isinstance(chunk.get("publicResult"), str):
        try:
            parsed = json.loads(chunk["publicResult"])
            result = parsed if isinstance(parsed, dict) else {}
        except ValueError:
            result = {}
    tool_input = result.get("input")
    if tool_input is None and isinstance(args, dict) and args.get("type") != "tool":
        tool_input = args
    summary = ""
    if isinstance(args, str):
        summary = args
    elif isinstance(tool_input, dict):
        first = next((tool_input[k] for k in ("command", "path", "file_path", "pattern", "url", "query")
                      if isinstance(tool_input.get(k), str) and tool_input[k]), "")
        summary = first.strip().splitlines()[0] if first.strip() else ""
    output = result.get("output") if isinstance(result.get("output"), dict) else {}
    state = output.get("status")
    if chunk.get("success") is False or state in ("failed", "error") or chunk.get("isInterrupted") is True:
        status = "failed"
    elif chunk.get("isDone") is True or state == "completed":
        status = "completed"
    else:
        status = "running"
    output_text = _tool_output(output.get("value", output.get("error")))
    if isinstance(tool_input, (dict, list)) and len(json.dumps(tool_input, ensure_ascii=False)) > MAX_TEXT:
        tool_input = _clip(json.dumps(tool_input, ensure_ascii=False, indent=2))
    return {**base, "type": "effect", "title": name,
            "detail": {"toolName": name, "input": tool_input, "display": {"summary": summary[:200]}},
            "state": {"status": status, "outputText": _clip(output_text)},
            "createdAt": _ms(chunk.get("startTime"), at), "updatedAt": _ms(chunk.get("endTime"), _ms(chunk.get("startTime"), at))}


def _pending_callback(chunk: dict, base: dict, at: float) -> Optional[dict]:
    """An open question, confirmation or permission request, shaped for the answer cards."""
    name, data = chunk.get("callbackName"), chunk.get("input") if isinstance(chunk.get("input"), dict) else {}
    callback_id = chunk.get("callbackId")
    if not isinstance(callback_id, str) or not callback_id:
        return None
    entry = {**base, "type": "callback", "callbackId": callback_id, "state": {"status": "open"},
             "createdAt": at, "updatedAt": at}
    if name == "ask_user_question":
        questions = [{"question": q["question"], "hideOther": False,
                      "options": [{"label": o} for o in q.get("options") or [] if isinstance(o, str)]}
                     for q in data.get("questions") or [] if isinstance(q, dict) and isinstance(q.get("question"), str)]
        return {**entry, "title": "Question", "detail": {"kind": "user_input", "cloudCallback": name, "request": {"questions": questions}}}
    if name == "ask_user_confirmation":
        task = data.get("taskName") if isinstance(data.get("taskName"), str) else "Action"
        reason = data.get("confirmationReason") if isinstance(data.get("confirmationReason"), str) else None
        return {**entry, "title": task, "detail": {"kind": "approval", "cloudCallback": name, "choices": ["approve", "deny"], "reason": reason}}
    if name == "ask_user_permission":
        options = [o for o in data.get("options") or [] if isinstance(o, dict)]
        ids = [o.get("id") or o.get("optionId") for o in options]
        labels = {i: (o.get("label") or o.get("title") or i) for i, o in zip(ids, options) if isinstance(i, str)}
        if not labels:
            return None
        effect = data.get("effect")
        title = (effect.get("summary") or effect.get("title") or effect.get("name")) if isinstance(effect, dict) else effect
        return {**entry, "title": title if isinstance(title, str) and title else "Permission requested",
                "detail": {"kind": "approval", "cloudCallback": name, "choices": list(labels), "labels": labels,
                           "reason": data.get("reason") if isinstance(data.get("reason"), str) else None}}
    return None


def _callback_text(chunk: dict) -> str:
    data = chunk.get("input") if isinstance(chunk.get("input"), dict) else {}
    lines = []
    if chunk.get("callbackName") == "ask_user_confirmation" and isinstance(data.get("taskName"), str):
        lines.append(f"**Approval:** {data['taskName']}")
    if chunk.get("callbackName") == "ask_enable_connector":
        lines.append("**Connector requested.** Enable it on chat.mistral.ai to continue.")
    for q in data.get("questions") or []:
        if isinstance(q, dict) and isinstance(q.get("question"), str):
            lines.append(f"**{q['question']}**")
            lines.extend(f"- {o}" for o in q.get("options") or [] if isinstance(o, str))
    answer = (chunk.get("result") or {}).get("value") if isinstance(chunk.get("result"), dict) else None
    if isinstance(answer, list) and answer:
        lines.append("\nAnswer: " + ", ".join(str(a) for a in answer))
    elif isinstance(answer, dict) and isinstance(answer.get("confirmation"), str):
        lines.append(f"Answer: {answer['confirmation']}")
    elif isinstance(answer, dict) and isinstance(answer.get("optionId"), str):
        lines.append(f"Answer: {answer['optionId']}")
    return "\n".join(lines)


def parse_messages(data: Any, session_id: str) -> tuple[list[dict], Optional[str]]:
    """History entries in turn order: user prompt, then the agent's steps."""
    messages = data.get("messages") if isinstance(data, dict) else None
    if not isinstance(messages, list):
        raise CloudError("unavailable", "Vibe Code Web returned an unexpected transcript.")
    rows = [m for m in messages if isinstance(m, dict) and isinstance(m.get("id"), str) and m.get("role") in ("user", "assistant")]
    rows.sort(key=lambda m: (m.get("turn") if isinstance(m.get("turn"), int) else 0,
                             0 if m["role"] == "user" else 1, m.get("createdAt") or ""))
    entries: list[dict] = []
    for message in rows:
        at = (_seconds(message.get("createdAt")) or 0) * 1000
        turn = f"turn-{message.get('turn', 0)}"
        text_run: list[str] = []
        run_start = [0]

        def base(index: int) -> dict:
            return {"id": f"{message['id']}:{index}", "sessionId": session_id, "turnId": turn}

        def flush() -> None:
            text = "\n\n".join(t for t in text_run if t.strip())
            text_run.clear()
            if text.strip():
                entries.append({**base(run_start[0]), "type": "message", "role": message["role"],
                                "content": [{"type": "text", "text": text}], "createdAt": at, "updatedAt": at})

        for index, chunk in enumerate(message.get("contentChunks") or []):
            if not isinstance(chunk, dict):
                continue
            kind = chunk.get("type")
            context = chunk.get("_context") if isinstance(chunk.get("_context"), dict) else {}
            if kind == "text" and context.get("type") == "reasoning":
                flush()
                if isinstance(chunk.get("text"), str) and chunk["text"].strip():
                    streaming = message.get("status") not in (None, "complete", "completed") and not context.get("endTime")
                    entries.append({**base(index), "type": "reasoning", "text": _clip(chunk["text"]),
                                    "generationStatus": "in_progress" if streaming else "completed",
                                    "createdAt": _ms(context.get("startTime"), at),
                                    "updatedAt": _ms(context.get("endTime"), _ms(context.get("startTime"), at))})
            elif kind == "text":
                if isinstance(chunk.get("text"), str):
                    if not text_run:
                        run_start[0] = index
                    text_run.append(chunk["text"])
            elif kind == "tool_call":
                flush()
                entries.append(_tool_entry(chunk, base(index), at))
            elif kind == "task_callback":
                flush()
                result = chunk.get("result") if isinstance(chunk.get("result"), dict) else {}
                pending = _pending_callback(chunk, base(index), at) if result.get("status") == "pending" else None
                if pending:
                    entries.append(pending)
                    continue
                text = _callback_text(chunk)
                if text:
                    entries.append({**base(index), "type": "message", "role": "assistant",
                                    "content": [{"type": "text", "text": text}], "createdAt": at, "updatedAt": at})
        flush()
    cursor = data.get("nextCursor")
    return entries, cursor if isinstance(cursor, str) and cursor else None
