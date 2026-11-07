"""Real Vibe main/subagent routing with isolated, loopback protocol fixtures.

No credentials or paid calls. Exercises OpenAI, Anthropic and Responses wire
formats, every preset as main/worker, and reverse delegation to Mistral.
"""
import asyncio
import json
import os
import sys
import tempfile
import threading
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sidecar"))
import providers  # noqa: E402
from agent_routing import AgentSettings, write_settings  # noqa: E402
from vibe_bridge import VibeAppServer  # noqa: E402

CASES = {"mistral-test": "openai", "deepseek-test": "openai", "zai-test": "openai",
         "minimax-test": "openai", "google-test": "openai", "ollama-test": "openai",
         "claude-test": "anthropic", "openai-test": "openai-responses"}


class Fixture(BaseHTTPRequestHandler):
    calls = []
    delegated = set()
    workers = []
    discovered = set()
    fail = set()
    requests = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        name = body["model"]
        self.calls.append((name, self.path))
        self.requests.append(body)
        if name in self.fail:
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"private fixture provider error"}}')
            return
        messages = json.dumps(body.get("messages", body.get("input", [])))
        tool = None
        builtin = "DELEGATE_BUILTIN" in messages
        if builtin and name == "mistral-test" and name not in self.delegated:
            self.delegated.add(name)
            code = "async function main() { return await tools.mcp_vibedeck_providers.delegate({jobs:[{provider:'deepseek-test',quality:'strong',effort:'high',task:'Review supplied context',access:'context'},{provider:'zai-test',quality:'strong',effort:'high',task:'Independent review',access:'context'}]}); }"
            tool = {"id":"builtin","type":"function","function":{"name":"run_typescript","arguments":json.dumps({"code":code})}}
        elif "DELEGATE_ALL" in messages and name == "mistral-test" and name not in self.delegated:
            self.delegated.add(name)
            code = "async function main() { const results = []; "
            for worker in self.workers:
                code += f"results.push(await tools.mcp_vibedeck_providers.provider_task({{model:{json.dumps(worker)},task:'Reply PROVIDER_OK without tools.',max_tokens:32}})); "
            code += "return results; }"
            tool = {"id": "delegate-all", "type": "function", "function": {"name": "run_typescript", "arguments": json.dumps({"code": code})}}
        elif "DELEGATE_REVERSE" in messages and name != "mistral-test" and name not in self.delegated:
            self.delegated.add(name)
            code = "async function main() { return await tools.mcp_vibedeck_providers.provider_task({model:'mistral-test',task:'Reply PROVIDER_OK without tools.',max_tokens:32}); }"
            tool = {"id": "delegate-reverse", "type": "function", "function": {"name": "run_typescript", "arguments": json.dumps({"code": code})}}
        if tool and (name,builtin) not in self.discovered:
            self.delegated.discard(name)
            self.discovered.add((name,builtin))
            tool = {"id": "discover", "type": "function", "function": {"name": "search_tool_functions", "arguments": json.dumps({"mode": "details", "functions": ["mcp_vibedeck_providers.delegate" if builtin else "mcp_vibedeck_providers.provider_task"]})}}
        text = "PROVIDER_OK"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def event(value, kind=None):
            data = (f"event: {kind}\n" if kind else "") + "data: " + json.dumps(value) + "\n\n"
            self.wfile.write(data.encode())

        if self.path.endswith("/v1/messages"):
            event({"type": "message_start", "message": {"id": "msg-test", "type": "message", "role": "assistant", "model": name, "content": [], "usage": {"input_tokens": 10, "output_tokens": 0}}}, "message_start")
            if tool:
                event({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": tool["id"], "name": tool["function"]["name"], "input": {}}}, "content_block_start")
                event({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": tool["function"]["arguments"]}}, "content_block_delta")
            else:
                event({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}, "content_block_start")
                event({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}, "content_block_delta")
            event({"type": "content_block_stop", "index": 0}, "content_block_stop")
            event({"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else "end_turn"}, "usage": {"output_tokens": 2}}, "message_delta")
            event({"type": "message_stop"}, "message_stop")
        elif self.path.endswith("/responses"):
            item = {"id": "item-test", "type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]}
            if tool:
                item = {"id": "item-test", "type": "function_call", "call_id": tool["id"], "name": tool["function"]["name"], "arguments": tool["function"]["arguments"]}
            response = {"id": "resp-test", "object": "response", "model": name, "status": "completed", "output": [item], "usage": {"input_tokens": 10, "output_tokens": 2}}
            event({"type": "response.created", "response": {**response, "status": "in_progress", "output": []}}, "response.created")
            event({"type": "response.output_item.added", "output_index": 0, "item": {**item, "arguments": ""} if tool else {**item, "content": []}}, "response.output_item.added")
            if tool:
                event({"type": "response.function_call_arguments.delta", "item_id": "item-test", "output_index": 0, "delta": item["arguments"]}, "response.function_call_arguments.delta")
                event({"type": "response.output_item.done", "output_index": 0, "item": item}, "response.output_item.done")
            else:
                event({"type": "response.content_part.added", "item_id": "item-test", "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": ""}}, "response.content_part.added")
                event({"type": "response.output_text.delta", "item_id": "item-test", "output_index": 0, "content_index": 0, "delta": text}, "response.output_text.delta")
                event({"type": "response.output_text.done", "item_id": "item-test", "output_index": 0, "content_index": 0, "text": text}, "response.output_text.done")
            event({"type": "response.completed", "response": response}, "response.completed")
        else:
            delta = {"role": "assistant", "tool_calls": [{"index": 0, **tool}]} if tool else {"role": "assistant", "content": text}
            event({"id": "fixture", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]})
            event({"id": "fixture", "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if tool else "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2}})
            self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


async def turn(home, model, prompt, expect_error=False):
    bridge = VibeAppServer(str(home))
    try:
        await bridge.start()
        await bridge.start_session()
        await bridge.set_model(bridge.session_id, model, "off")
        await bridge.set_agent(bridge.session_id, "auto-approve")
        queue = bridge.subscribe(maxsize=10000)
        await bridge.send_turn(bridge.session_id, prompt)
        async with asyncio.timeout(120):
            while True:
                message = await queue.get()
                assert message, "Bridge closed unexpectedly"
                assert message.get("method") != "turn/failed", json.dumps(message)
                if message.get("method") == "turn/completed":
                    break
        history = json.dumps((await bridge.read_session(bridge.session_id))["state"]["history"])
        assert "PROVIDER_OK" in history, history[-4000:]
        if "DELEGATE" in prompt and not expect_error:
            assert "Unknown subagent" not in history and '"success": false' not in history, history[-6000:]
        return history
    finally:
        await bridge.close()


async def run():
    with tempfile.TemporaryDirectory(prefix="vibedeck-providers-") as tmp:
        home = Path(tmp)
        endpoint = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        threading.Thread(target=endpoint.serve_forever, daemon=True).start()
        for key in list(os.environ):
            if key.startswith("VIBE_") or key.endswith("_API_KEY"):
                os.environ.pop(key)
        os.environ.update(VIBE_HOME=tmp, PYTHON_KEYRING_BACKEND="keyring.backends.null.Keyring", DO_NOT_TRACK="1")
        config = f'active_model="mistral-test"\nconsole_base_url="http://127.0.0.1:{endpoint.server_port}"\n'
        for name, style in CASES.items():
            config += f'[[providers]]\nname="{name}"\napi_base="http://127.0.0.1:{endpoint.server_port}/{name}"\napi_style="{style}"\nbackend="generic"\napi_key_env_var=""\n[[models]]\nname="{name}"\nalias="{name}"\nprovider="{name}"\n'
        (home / "config.toml").write_text(config)
        providers.sync_subagents(home / "config.toml")
        try:
            for name in CASES:
                before = len(Fixture.calls)
                await turn(home, name, "Reply PROVIDER_OK without tools.")
                assert len(Fixture.calls) == before + 1, "Unexpected retries or extra model calls"
                print(f"PASS main: {name} ({CASES[name]})", flush=True)
            write_settings(AgentSettings(policy="auto",quality="strong"))
            history = await turn(home, "mistral-test", "DELEGATE_BUILTIN: use DeepSeek and Z.ai agents, strong models and high thinking, then answer PROVIDER_OK.")
            assert '"status": "completed"' in history or '\\"status\\":\\"completed\\"' in history.replace(" ", ""), history[-6000:]
            assert any("Proactively delegate" in json.dumps(r.get("messages",[])) for r in Fixture.requests if r["model"]=="mistral-test"), "Automatic policy did not reach the main model"
            write_settings(AgentSettings())
            print("PASS built-in delegate: Mistral main → DeepSeek and Z.ai with high thinking", flush=True)
            Fixture.delegated.clear()
            Fixture.workers = [name for name in CASES if name != "mistral-test"]
            before = Counter(name for name, _ in Fixture.calls)
            history = await turn(home, "mistral-test", "DELEGATE_ALL: use the configured provider workers, then answer PROVIDER_OK.")
            after = Counter(name for name, _ in Fixture.calls)
            for body in Fixture.requests[-10:]:
                if body["model"] != "mistral-test":
                    assert not body.get("tools")
                    messages = body.get("messages", body.get("input", []))
                    assert 1 <= len(messages) <= 2, "Worker inherited conversation history"
                    if body["model"] == "claude-test":
                        assert body.get("system"), "Anthropic system context missing"
                    assert body.get("max_tokens", body.get("max_output_tokens")) == 32
            for worker in Fixture.workers:
                assert after[worker] - before[worker] == 1, f"Worker did not run exactly once: {worker}\n{history[-5000:]}"
            assert after["mistral-test"] - before["mistral-test"] == 3
            print("PASS Mistral main → all seven other provider subagents", flush=True)
            for main in Fixture.workers:
                before = len(Fixture.calls)
                await turn(home, main, "DELEGATE_REVERSE: use Mistral as a subagent, then answer PROVIDER_OK.")
                assert len(Fixture.calls) == before + 4
                assert [name for name, _ in Fixture.calls[-4:]] == [main, main, "mistral-test", main]
                print(f"PASS {main} main → Mistral subagent; no extra calls", flush=True)
            Fixture.workers = ["deepseek-test"]
            Fixture.delegated.discard("mistral-test")
            Fixture.fail.add("deepseek-test")
            before = Counter(name for name, _ in Fixture.calls)
            history = await turn(home, "mistral-test", "DELEGATE_ALL: test an unavailable worker.", expect_error=True)
            after = Counter(name for name, _ in Fixture.calls)
            assert after["deepseek-test"] - before["deepseek-test"] == 1, "Failed worker was replayed"
            assert "Provider worker failed" in history and "private fixture provider error" not in history
            print("PASS failed worker: one attempt, safe error, no automatic replay", flush=True)
        finally:
            endpoint.shutdown()


if __name__ == "__main__":
    asyncio.run(run())
