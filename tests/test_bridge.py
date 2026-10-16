"""Integration test for the vibe-app-server JSON-RPC bridge.

Requires a real `vibe-app-server` (from the mistral-vibe CLI) and a valid Mistral
credential (the vibe CLI's own auth). Marked `integration`; skipped if the server
binary is missing. Consumes a tiny amount of API credit (one trivial turn).
"""
import asyncio
import shutil

import pytest
from vibe_bridge import BridgeError, VibeAppServer, find_app_server

pytestmark = pytest.mark.integration

HAVE = shutil.which("vibe-app-server") is not None


@pytest.mark.skipif(not HAVE, reason="vibe-app-server not installed")
def test_bridge_session_turn(tmp_path, monkeypatch):
    home = tmp_path / "vibe"
    home.mkdir()
    (home / "config.toml").write_text('''active_model = "paid-smoke"
[[providers]]
name = "mistral"
api_base = "https://api.mistral.ai/v1"
api_style = "openai"
backend = "generic"
api_key_env_var = "MISTRAL_API_KEY"
[[models]]
name = "ministral-3b-latest"
alias = "paid-smoke"
provider = "mistral"
thinking = "off"
''')
    monkeypatch.setenv("VIBE_HOME", str(home))
    monkeypatch.setenv("DO_NOT_TRACK", "1")
    async def run():
        b = VibeAppServer(cwd=str(tmp_path))
        try:
            await b.start()
            assert b.server_version
            await b.start_session()
            sid = b.session_id
            assert sid
            await b.set_model(sid, "paid-smoke", "off")
            await b.set_agent(sid, "ask")
            q = b.subscribe()
            await b.send_turn(sid, "Reply with exactly the word PONG. Do not call tools.")
            async with asyncio.timeout(90):
                while True:
                    msg = await q.get()
                    assert msg is not None, "Native bridge closed before the turn completed"
                    assert msg.get("method") != "turn/failed", "Native turn failed"
                    if msg.get("method") == "turn/completed":
                        break
            history = (await b.read_session(sid))["state"]["history"]
            return "".join(c.get("text", "") for e in history
                           if e.get("type") == "message" and e.get("role") == "assistant"
                           for c in e.get("content", []) if c.get("type") == "text")
        finally:
            await b.close()

    text = asyncio.run(run())
    assert "PONG" in text


def test_find_app_server_or_raises():
    try:
        path = find_app_server()
        assert path
    except FileNotFoundError:
        pytest.skip("vibe-app-server not installed")


def test_bridge_error_shape():
    e = BridgeError("invalid_params", "bad", {"x": 1})
    assert e.code == "invalid_params"
    assert "bad" in str(e)
