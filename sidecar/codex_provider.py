"""Model bridge to the official Codex app-server; OAuth stays with Codex.

Vibe owns history, tool execution and approvals. Codex dynamic tools return to
Vibe as function calls; their results continue the same Codex turn. No token
files are read, copied, or exposed. Idle tool continuations expire after 5 min.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import shutil
import tempfile
import time
from contextlib import aclosing
from pathlib import Path

from vibe_bridge import BridgeError, VibeAppServer


class CodexClient(VibeAppServer):
    def __init__(self, cwd: str):
        executable = shutil.which("codex")
        if not executable:
            raise BridgeError("missing_codex", "Install the official Codex CLI to use ChatGPT sign-in.")
        super().__init__(cwd, server_cmd=executable)

    async def start(self):
        self._proc = await asyncio.create_subprocess_exec(
            self.server_cmd, "app-server", "--stdio", stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            cwd=self.cwd, limit=64 * 1024 * 1024)
        self._reader_task = asyncio.create_task(self._read_loop())
        try:
            await self.call("initialize", {"clientInfo": {"name": "vibedeck", "version": "1.1.0"},
                                           "capabilities": {"experimentalApi": True}})
            self._send_raw({"method": "initialized", "params": {}})
        except BaseException:
            await self.close()
            raise

    def _handle_server_request(self, message):
        if message.get("method") == "item/tool/call":
            for queue in self._subscribers:
                queue.put_nowait({"method": "vibedeck/tool", "params": message})
        else:
            # This is a model adapter. Vibe, not Codex, executes approved tools.
            self._send_raw({"id": message["id"], "error": {"code": -32601,
                            "message": "Execute tools through VibeDeck's supplied dynamic tools."}})


class CodexProvider:
    def __init__(self):
        self.auth = None
        self.auth_lock = asyncio.Lock()
        self.pending = {}
        self.contexts = {}

    async def account_client(self):
        async with self.auth_lock:
            if self.auth is None or not self.auth.alive:
                self.auth = CodexClient(str(Path.home()))
                await self.auth.start()
            return self.auth

    async def account(self):
        client = await self.account_client()
        result = await client.call("account/read", {"refreshToken": False})
        account = result.get("account") or {}
        return {"installed": True, "connected": bool(account), "type": account.get("type"),
                "plan": account.get("planType"), "requiresLogin": not bool(account)}

    async def login(self):
        client = await self.account_client()
        result = await client.call("account/login/start", {"type": "chatgpt"})
        # The official CLI owns the loopback callback and credential storage.
        return {"authUrl": result.get("authUrl"), "loginId": result.get("loginId")}

    async def models(self):
        client = await self.account_client()
        result = await client.call("model/list", {})
        return [{"id": m.get("model") or m["id"], "name": m.get("displayName") or m["id"]}
                for m in result.get("data", [])]

    async def close_context(self, context):
        self.contexts.pop(id(context), None)
        for key, value in list(self.pending.items()):
            if value[0] is context:
                self.pending.pop(key, None)
        expiry = context.get("expiry")
        if expiry and expiry is not asyncio.current_task():
            expiry.cancel()
        await context["client"].close()
        context["home"].cleanup()

    async def close(self):
        for context in list(self.contexts.values()):
            await self.close_context(context)
        if self.auth:
            await self.auth.close()

    async def expire(self, context):
        await asyncio.sleep(300)
        await self.close_context(context)

    @staticmethod
    def requested_effort(body):
        effort = body.get("reasoning_effort")
        if effort is None or effort == "auto":
            return None
        if not isinstance(effort, str) or not effort or effort.strip() != effort:
            raise BridgeError("unsupported", "Codex reasoning effort must be a supported model setting.")
        return effort

    async def resolve_effort(self, client, model, requested):
        if requested is None:
            return None
        cursor, seen = None, set()
        while True:
            result = await client.call("model/list", {"cursor": cursor} if cursor else {})
            if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                raise BridgeError("unsupported", "Could not verify reasoning effort for this Codex model.")
            for entry in result["data"]:
                if not isinstance(entry, dict):
                    continue
                if model not in (entry.get("id"), entry.get("model")):
                    continue
                options = entry.get("supportedReasoningEfforts")
                if not isinstance(options, list):
                    raise BridgeError("unsupported", "Could not verify reasoning effort for this Codex model.")
                supported = {option["reasoningEffort"] for option in options
                             if isinstance(option, dict) and isinstance(option.get("reasoningEffort"), str)}
                effort = requested if requested in supported else {"off": "none", "max": "xhigh"}.get(requested)
                if effort and effort in supported:
                    return effort
                raise BridgeError("unsupported", "This Codex model does not support the requested reasoning effort.")
            cursor = result.get("nextCursor")
            if not cursor or not isinstance(cursor, str) or cursor in seen:
                raise BridgeError("unsupported", "Could not verify reasoning effort for this Codex model.")
            seen.add(cursor)

    async def new_context(self, body):
        requested = self.requested_effort(body)
        messages = body["messages"]
        if any(not isinstance(m.get("content", ""), (str, type(None))) for m in messages):
            raise BridgeError("unsupported", "The Codex OAuth model bridge currently accepts text and tool messages only.")
        home = tempfile.TemporaryDirectory(prefix="vibedeck-codex-model-")
        client = CodexClient(home.name)
        context = {"client": client, "home": home, "model": body["model"], "lock": asyncio.Lock()}
        self.contexts[id(context)] = context
        try:
            await client.start()
            context["requested_effort"] = requested
            context["effort"] = await self.resolve_effort(client, body["model"], requested)
            config = (await client.call("config/read", {"includeLayers": False})).get("config") or {}
            overrides = {"features.shell_tool": False, "features.multi_agent": False,
                         "features.sleep_tool": False, "features.tool_suggest": False,
                         "web_search": "disabled", "apps._default.enabled": False}
            for section in ("mcp_servers", "plugins"):
                overrides[section] = {name: {"enabled": False} for name in (config.get(section) or {})}
            tools = []
            names = {}
            for index, tool in enumerate(body.get("tools") or []):
                function = tool.get("function") or {}
                if tool.get("type") != "function" or not function.get("name"):
                    raise BridgeError("unsupported", "Codex OAuth accepts function tools only.")
                name = f"vibedeck_tool_{index}"
                names[name] = function["name"]
                tools.append({"type": "function", "name": name,
                              "description": f"{function['name']}: {function.get('description', '')}",
                              "inputSchema": function.get("parameters") or {"type": "object", "properties": {}}})
            context["names"] = names
            context["queue"] = client.subscribe(maxsize=10000)
            instructions = "\n".join(m.get("content") or "" for m in messages if m.get("role") in ("system", "developer"))
            # shortcut: Codex app-server has no hard output-token cap; upgrade when its protocol exposes one.
            if body.get("max_tokens"):
                instructions += f"\nKeep your answer under {body['max_tokens']} output tokens."
            instructions += "\nYou are the model for VibeDeck. Use only the supplied vibedeck_tool_* dynamic tools for all actions. VibeDeck runs them and obtains approvals. Never use built-in tools. Answer the user's request directly."
            thread = await client.call("thread/start", {"model": body["model"], "modelProvider": "openai",
                "cwd": home.name, "sandbox": "read-only", "approvalPolicy": "never", "ephemeral": True,
                "baseInstructions": instructions, "config": overrides, "dynamicTools": tools})
            context["thread"] = thread["thread"]["id"]
            transcript = [{k: v for k, v in m.items() if k in ("role", "content", "tool_calls", "tool_call_id")}
                          for m in messages if m.get("role") not in ("system", "developer")]
            turn = {"threadId": context["thread"], "input": [
                {"type": "text", "text": json.dumps(transcript, ensure_ascii=False), "text_elements": []}]}
            if context["effort"] is not None:
                turn["effort"] = context["effort"]
            await client.call("turn/start", turn)
            return context
        except BaseException:
            await self.close_context(context)
            raise

    async def chunks(self, body):
        requested = self.requested_effort(body)
        context = None
        handed_off = False
        # A continuation is identified by the unguessable tool call ID, never by
        # prompt text; concurrent sessions and providers cannot share a turn.
        outputs = []
        for message in reversed(body["messages"]):
            if message.get("role") != "tool":
                break
            outputs.insert(0, message)
        matching = [m for m in outputs if m.get("tool_call_id") in self.pending]
        try:
            if matching:
                if len(matching) != len(outputs):
                    raise BridgeError("invalid", "Some tool results are unknown or expired.")
                contexts = {id(self.pending[m["tool_call_id"]][0]) for m in matching}
                if len(contexts) != 1:
                    raise BridgeError("invalid", "Tool results belong to different Codex turns.")
                context = self.pending[matching[0]["tool_call_id"]][0]
                if context["model"] != body["model"] or context["lock"].locked():
                    context = None
                    raise BridgeError("conflict", "Codex continuation is already in use or its model changed.")
                if requested is not None and requested not in (context.get("requested_effort"), context.get("effort")):
                    context = None
                    raise BridgeError("conflict", "Codex reasoning effort cannot change during a tool continuation.")
            elif outputs:
                raise BridgeError("expired", "Codex tool continuation expired. Start a new turn; it will not be replayed automatically.")
            else:
                context = await self.new_context(body)
            async with context["lock"]:
                if context.get("expiry"):
                    context["expiry"].cancel()
                for message in matching:
                    _, request_id = self.pending.pop(message["tool_call_id"])
                    context["client"]._send_raw({"id": request_id, "result": {"success": True,
                        "contentItems": [{"type": "inputText", "text": message.get("content") or ""}]}})
                async with asyncio.timeout(180):
                    while True:
                        event = await context["queue"].get()
                        if event is None:
                            raise BridgeError("closed", "Codex app-server closed.")
                        method, params = event["method"], event.get("params") or {}
                        if method == "item/agentMessage/delta":
                            yield {"delta": {"content": params.get("delta", "")}, "finish_reason": None}
                        elif method == "vibedeck/tool":
                            call = params["params"]
                            name = context["names"].get(call["tool"])
                            if name is None:
                                raise BridgeError("invalid", "Codex requested an unknown dynamic tool.")
                            key = "codex_" + secrets.token_hex(16)
                            self.pending[key] = (context, params["id"])
                            context["expiry"] = asyncio.create_task(self.expire(context))
                            handed_off = True
                            yield {"delta": {"tool_calls": [{"index": 0, "id": key, "type": "function",
                                "function": {"name": name, "arguments": json.dumps(call["arguments"])}}]}, "finish_reason": None}
                            yield {"delta": {}, "finish_reason": "tool_calls", "usage": context.pop("usage", {})}
                            return
                        elif method == "thread/tokenUsage/updated":
                            usage = (params.get("tokenUsage") or {}).get("last") or {}
                            context["usage"] = {"prompt_tokens": usage.get("inputTokens", 0),
                                "completion_tokens": usage.get("outputTokens", 0),
                                "prompt_tokens_details": {"cached_tokens": usage.get("cachedInputTokens", 0)}}
                        elif method == "turn/completed":
                            turn = params.get("turn") or {}
                            if turn.get("status") != "completed":
                                raise BridgeError("failed", "Codex turn failed or was interrupted. Check native Codex authentication and model access.")
                            yield {"delta": {}, "finish_reason": "stop", "usage": context.get("usage", {})}
                            return
        finally:
            if context and not handed_off:
                await self.close_context(context)

    async def stream(self, body, chunks=None, first=None):
        request_id = "chatcmpl-" + secrets.token_hex(12)
        iterator = chunks if chunks is not None else self.chunks(body)
        try:
            async def events():
                if first is not None:
                    yield first
                async for item in iterator:
                    yield item
            async with aclosing(iterator):
                async for chunk in events():
                    result = {"id": request_id, "object": "chat.completion.chunk", "created": int(time.time()),
                              "model": body["model"], "choices": [{"index": 0, **{k: v for k, v in chunk.items() if k != "usage"}}]}
                    if "usage" in chunk:
                        result["usage"] = chunk["usage"]
                    yield "data: " + json.dumps(result) + "\n\n"
            yield "data: [DONE]\n\n"
        except (BridgeError, TimeoutError, OSError):
            # Provider/server details can contain credentials; return a safe error.
            yield 'data: {"error":{"message":"Codex model request failed. Check sign-in/model access; no automatic replay was made."}}\n\n'
