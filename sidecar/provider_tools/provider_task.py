"""Bounded provider workers over MCP, shared by native Vibe and VibeDeck."""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import os
import shutil
import signal
import sys
from pathlib import Path
from typing import Annotated

from agent_routing import AgentJob, delegation_instructions, describe_models, read_settings, select_model
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from pydantic import Field
from vibe.core.config.default_orchestrator import build_default_orchestrator
from vibe.core.config.harness_files import init_harness_files_manager
from vibe.core.llm.backend.factory import create_backend
from vibe.core.types import LLMMessage, Role

# Native CLI uses this same credential file; MCP does not inherit API key env vars.
load_dotenv(Path(os.environ.get("VIBE_HOME", Path.home() / ".vibe")) / ".env")
os.environ.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
os.environ.setdefault("DBUS_SESSION_BUS_ADDRESS", "unix:path=" + os.environ["XDG_RUNTIME_DIR"] + "/bus")

init_harness_files_manager("user", "project")

server = FastMCP("vibedeck_providers", log_level="ERROR", instructions=delegation_instructions())
WORKERS = asyncio.Semaphore(2)
EDITOR = asyncio.Lock()


@server.tool()
async def provider_task(
    model: str,
    task: Annotated[str, Field(min_length=1, max_length=20000)],
    max_tokens: Annotated[int, Field(ge=32, le=8192)] = 1024,
    effort: str = "auto",
) -> dict:
    """Compatibility context worker. Prefer delegate for built-in subagents.

    Delegate ONLY when requested by the user, using an exact configured model alias.

    Worker receives only this task/context, makes one bounded model request with
    no tools/history, and returns findings or a proposed patch. Parent reviews
    and performs edits under its approval policy. Use this instead of native
    subagent.spawn for other providers: Vibe 2.26 children inherit the parent model.
    Discover aliases with list_models. Do not automatically repeat failed tasks.
    """
    async with WORKERS:
        return await _context_task(model, task, max_tokens, effort)


async def _context_task(model: str, task: str, max_tokens: int, effort: str) -> dict:
    config = (await build_default_orchestrator()).config
    settings = read_settings()
    if settings.policy == "off":
        raise ValueError("Subagents are disabled in Settings → Config.")
    selected, _ = select_model(config.available_models(), AgentJob(model=model, task=task, effort=effort), settings)
    provider = config.get_provider_for_model(selected)
    text, usage = "", {}
    try:
        backend = create_backend(provider=provider, retry_max_elapsed_time=0)
        async with asyncio.timeout(180), backend:
            async for chunk in backend.complete_streaming(model=selected, temperature=selected.temperature, max_tokens=max_tokens,
                messages=[LLMMessage(role=Role.system, content="Complete this bounded task concisely. Return findings or a proposed patch. Do not claim to have executed tools or changed files."),
                          LLMMessage(role=Role.user, content=task)]):
                text += chunk.message.content or ""
                if chunk.usage:
                    usage = chunk.usage.model_dump()
    except Exception:
        raise ValueError("Provider worker failed. Check key/model/quota. No automatic replay was made.") from None
    return {"provider": provider.name, "model": selected.alias, "thinking": selected.thinking, "text": text, "usage": usage}


@server.tool()
async def list_models() -> list[dict]:
    """List configured provider model aliases allowed for explicit delegation."""
    config = (await build_default_orchestrator()).config
    return describe_models(config.available_models())


async def repo_agent(selected, job: AgentJob) -> dict:
    adjacent = Path(sys.executable).with_name("vibe")
    cli = str(adjacent) if adjacent.is_file() else shutil.which("vibe")
    if not cli:
        raise ValueError("Install the Vibe CLI before running repository agents.")
    env = dict(os.environ)
    env.update(VIBE_ACTIVE_MODEL=selected.alias, VIBE_MODELS=json.dumps([selected.model_dump(exclude_none=True)]),
               VIBE_API_RETRY_MAX_ELAPSED_TIME="0")
    tools = ["read_file", "grep"] + (["write_file", "edit"] if job.access == "edit" else [])
    args = [cli, "--trust", "--agent", "accept-edits" if job.access == "edit" else "ask",
            "--prompt", "--max-turns", "6", "--max-tokens", "24000", "--output", "json"]
    for tool in tools:
        args.extend(["--enabled-tools", tool])
    lock = None
    if job.access == "edit":
        directory = Path(os.environ.get("VIBE_HOME", Path.home() / ".vibe")) / "vibedeck"
        directory.mkdir(parents=True, exist_ok=True)
        name = hashlib.sha256(str(Path.cwd().resolve()).encode()).hexdigest()
        lock = os.fdopen(os.open(directory / ("edit-" + name + ".lock"), os.O_CREAT | os.O_RDWR, 0o600), "w")
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            raise ValueError("Another worker is editing this project. Finish it before starting another.") from None
    process = None
    try:
        process = await asyncio.create_subprocess_exec(*args, env=env, start_new_session=True,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        prompt = "Complete this bounded task. Do not delegate or read credentials. Return concise findings or a summary of your changes.\n" + job.task
        stdout, _ = await asyncio.wait_for(process.communicate(prompt.encode()), timeout=175)
        if process.returncode:
            raise ValueError("Repository agent failed; check the provider configuration. No automatic replay was made.")
        history = json.loads(stdout)
        replies = [entry for entry in history if entry.get("type") == "message" and entry.get("role") == "assistant"]
        text = "\n".join(part.get("text", "") for entry in replies[-1:] for part in entry.get("content", []) if part.get("type") == "text")
        if not text:
            raise ValueError("Repository agent stopped without a final reply. Its CLI session is preserved for inspection.")
        return {"text": text[:16000], "access": job.access}
    finally:
        if process is not None and process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                await asyncio.wait_for(process.wait(), timeout=3)
            except (ProcessLookupError, asyncio.TimeoutError):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()
        if lock is not None:
            lock.close()


@server.tool()
async def agent_policy() -> dict:
    """Read delegation policy before using agents. No model requests.

    Requested (default): delegate when the user asks for agents, including casual
    'send off subagents'. Auto: also delegate substantial independent work when
    useful. Off: no delegation. Never split trivial work, duplicate tasks, send
    credentials, or delegate recursively. Choose strengths for the task, not quota.
    """
    return read_settings().model_dump()


@server.tool()
async def delegate(
    jobs: Annotated[list[AgentJob], Field(min_length=1, max_length=3)],
    automatic: bool = False,
) -> list[dict]:
    """VibeDeck built-in subagents, including Mistral and other configured providers.

    Use when the user asks for subagents, or automatic=True only when agent_policy
    enables auto delegation. 'Use DeepSeek and Z.ai strong models/high thinking'
    means two jobs with those provider names, quality='strong', effort='high'.
    Exact model aliases/providers/effort are mandatory constraints, never silently
    replaced. Discover aliases/strengths with list_models. Auto chooses among
    configured models using name-based tier/task hints, not live benchmarks.
    Keep small tasks local; prefer one worker and at most two independent streams.
    Context access makes one model call using supplied context only. Read access
    uses the Vibe tool harness with read/grep only; edit also allows file edits.
    Workers cannot run shell commands, delegate recursively, or approve actions.
    Parent reviews results, runs tests, and applies its own approval policy.
    Each repository worker has six turns, 24k cumulative tokens and 175 seconds.
    Failed jobs are not retried. Report failures and partial edits to the user.
    """
    settings = read_settings()
    if settings.policy == "off" or (automatic and settings.policy != "auto"):
        raise ValueError("This delegation is disabled by Settings → Config → Subagents.")
    if len(jobs) > settings.max_workers:
        raise ValueError("Batch exceeds the configured worker limit; reduce the independent tasks.")
    if automatic and any(job.access == "edit" for job in jobs):
        raise ValueError("Automatic workers are read-only. Request editing explicitly under the parent approval policy.")
    if sum(job.access == "edit" for job in jobs) > 1:
        raise ValueError("Run only one editing worker per batch; use read-only reviewers alongside it.")
    config = (await build_default_orchestrator()).config
    chosen = [(job, *select_model(config.available_models(), job, settings)) for job in jobs]
    identities = [(model.alias, job.task.strip(), job.access) for job, model, _ in chosen]
    if len(set(identities)) != len(identities):
        raise ValueError("Duplicate jobs would waste tokens; no requests were sent.")

    async def run(job, model, reason):
        async with WORKERS:
            result = {"provider": model.provider, "model": model.alias, "thinking": model.thinking, "selection": reason}
            try:
                if job.access == "context":
                    budget = 8192 if model.thinking in ("high", "max") else 2048
                    output = await _context_task(model.alias, job.task, budget, model.thinking)
                elif job.access == "edit":
                    async with EDITOR:
                        output = await repo_agent(model, job)
                else:
                    output = await repo_agent(model, job)
                return {**output, **result, "status": "completed"}
            except Exception:
                return {**result, "status": "failed", "detail": "Worker failed or reached a limit. No fallback or replay. Inspect its CLI session and any partial edits before retrying."}
    return await asyncio.gather(*(run(*item) for item in chosen))


if __name__ == "__main__":
    server.run(transport="stdio")
