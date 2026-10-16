"""Opt-in real Vibe CLI/app-server round trip against a local fake provider.

Run with the sidecar venv. Uses an isolated VIBE_HOME, no real credentials, and
only a loopback model endpoint. Requires the installed mistral-vibe CLI.
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sidecar"))
from vibe_bridge import VibeAppServer  # noqa: E402


class MockModel(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.requests.append(body)
        text = "LOCAL_INTEROP_OK"
        if body.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, finish in [({"role": "assistant", "content": text}, None), ({}, "stop")]:
                data = {"id": "local", "object": "chat.completion.chunk", "created": int(time.time()), "model": "local",
                        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}}
                self.wfile.write(f"data: {json.dumps(data)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            result = {"id": "local", "object": "chat.completion", "model": "local", "created": int(time.time()),
                      "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                      "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())


async def run():
    cli = shutil.which("vibe")
    assert cli, "Install mistral-vibe before this opt-in check"
    with tempfile.TemporaryDirectory(prefix="vibedeck-native-") as temporary:
        home = Path(temporary)
        endpoint = ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
        threading.Thread(target=endpoint.serve_forever, daemon=True).start()
        (home / "config.toml").write_text(f'''active_model = "local"
default_agent = "ask"
vibe_base_url = "http://127.0.0.1:{endpoint.server_port}"
[[providers]]
name = "local"
api_base = "http://127.0.0.1:{endpoint.server_port}/v1"
api_style = "openai"
backend = "generic"
api_key_env_var = ""
[[models]]
name = "local"
alias = "local"
provider = "local"
input_price = 0.0
output_price = 0.0
''')
        # Native Vibe reads these values in its subprocess, never the user's auth.
        for name in list(os.environ):
            if name.startswith("VIBE_") or name in ("MISTRAL_API_KEY", "MISTRAL_ADMIN_API_KEY"):
                os.environ.pop(name)
        os.environ.update(VIBEDECK_DATA=str(home / "desktop"), VIBE_HOME=str(home), PYTHON_KEYRING_BACKEND="keyring.backends.null.Keyring", DO_NOT_TRACK="1")
        bridge = VibeAppServer(str(home))
        try:
            await bridge.start()
            await bridge.start_session()
            sid = bridge.session_id
            await bridge.set_model(sid, "local")
            import vibedeck_server as desktop
            desktop.store.upsert_session(sid, cwd=str(home), model="local", agent="ask", status="idle")
            desktop.manager.register(sid, bridge)
            desktop._start_tap(sid, bridge)
            queue = bridge.subscribe()
            request = desktop.TurnReq(text="Desktop round trip", requestId="native-desktop")
            first = await desktop.send_turn(sid, request)
            async with asyncio.timeout(45):
                while True:
                    event = await queue.get()
                    assert event is not None, "native bridge closed unexpectedly"
                    if event.get("method") == "turn/completed":
                        break
            assert await desktop.send_turn(sid, request) == first
            state = (await bridge.read_session(sid))["state"]
            desktop._persist_session_state(sid, state)
            history = state["history"]
            assert "LOCAL_INTEROP_OK" in json.dumps(history), history
            await desktop._read_vibe_models()
            import providers
            providers.upsert_model({"name": "local", "alias": "local-alt", "provider": "local"}, home / "config.toml")
            assert "local-alt" in {m["id"] for m in await desktop._read_vibe_models()}
            updated = await desktop.patch_session(sid, desktop.SessionPatch(model="local-alt"))
            assert updated["model"] == "local-alt", "Existing idle bridge did not reload the shared CLI model registry"
        finally:
            await bridge.close()
        # The actual CLI acquires the same session after the desktop releases it.
        process = await asyncio.create_subprocess_exec(cli, "--workdir", str(home), "--trust", "--resume", sid,
            "--prompt", "CLI round trip", "--max-turns", "1", "--output", "json",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=60)
        assert process.returncode == 0, stderr.decode()[-3000:]
        assert b"LOCAL_INTEROP_OK" in stdout, stdout.decode()[-3000:]
        reopened = VibeAppServer(str(home))
        try:
            await reopened.start()
            await reopened.resume_session(sid)
            history = (await reopened.read_session(reopened.session_id))["state"]["history"]
            assert "Desktop round trip" in json.dumps(history)
            assert "CLI round trip" in json.dumps(history)
            assert len(MockModel.requests) == 2, f"Unexpected extra model calls: {len(MockModel.requests)}"
            print(f"PASS: desktop → CLI → desktop and external CLI config refresh; {len(history)} history entries; exactly 2 local model calls")
        finally:
            await reopened.close()
            endpoint.shutdown()


if __name__ == "__main__":
    asyncio.run(run())
