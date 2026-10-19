"""Opt-in browser regression check. Requires Playwright and installed Chrome.

Serves the production frontend and mocks every API/desktop call. No credentials
or model endpoints are used. Screenshots go to the supplied artifact directory.
"""
import asyncio
import functools
import json
import os
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sidecar"))
from providers import PRESETS  # noqa: E402


class Assets(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if not (ROOT / "frontend/dist" / self.path.lstrip("/").split("?")[0]).is_file():
            self.path = "/index.html"
        try:
            super().do_GET()
        except (BrokenPipeError, ConnectionResetError):
            pass  # Navigation can cancel an unfinished asset request.


async def run():
    artifacts = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/vibedeck-browser")
    artifacts.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Assets, directory=str(ROOT / "frontend/dist")))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    api_calls, callbacks, chats, errors, external = [], [], [], [], []
    key_saves, model_saves, config_saves = [], [], []
    deletion_failures = []
    library_saves = []
    library_attempts = []
    workspace_unavailable = False
    workspace_empty = False
    session_creations, turn_attempts, session_patches = [], [], []
    mcp_unavailable = audit_unavailable = False
    mcp_empty = False
    skills_unavailable = skills_save_fails = False
    shared_skills = False
    agent_settings = {"policy":"requested","quality":"balanced","max_workers":2}
    agent_saves = []
    agent_settings_corrupt = False
    skills_rows = []
    provider_rows = [{"name": "mistral", "apiBase": "https://api.mistral.ai/v1", "apiStyle": "openai", "backend": "mistral", "apiKeyEnvVar": "MISTRAL_API_KEY", "builtin": True, "key": {"present": True, "source": "keyring"}, "models": [{"alias": "mistral-large-4", "name": "mistral-large-4", "provider": "mistral"}]}]
    for preset in PRESETS:
        if preset["name"] in ("codex", "minimax", "google", "ollama"):
            provider_rows.append({"name": preset["name"], "apiBase": preset["api_base"], "apiStyle": preset["api_style"], "backend": "generic", "apiKeyEnvVar": preset["api_key_env_var"], "models": [], "key": {"present": preset["name"] in ("codex", "minimax"), "source": None}})
    sessions = [{"id": sid, "title": f"Session {sid}", "cwd": "/tmp", "agent": "ask", "model": "mistral-large-4", "reasoning": None,
                 "status": "idle", "lane": "work" if sid == "w" else "code", "updated_at": time.time(), "created_at": time.time(), "costs": {}} for sid in ("a", "b", "w")]
    config = {"defaultModel": "mistral-large-4", "defaultAgent": "accept-edits", "defaultReasoning": None,
              "agentModes": ["ask", "plan", "accept-edits"], "reasoningLevels": ["off", "high"], "approvalDecisions": ["approve", "deny"],
              "vibeModels": [{"id": "mistral-large-4", "name": "Mistral Large", "supportsImages": True, "thinkingLevels": []}]}
    question = {"id": "question", "callbackId": "q", "type": "callback", "state": {"status": "open"},
                "detail": {"kind": "user_input", "request": {"questions": [{"question": "Which target?", "options": [{"label": "Desktop"}, {"label": "CLI"}], "hideOther": False}]}}}
    async def route(request_route):
        nonlocal shared_skills
        request = request_route.request
        path = urlparse(request.url).path
        if not request.url.startswith(base):
            external.append(request.url)
            return await request_route.abort()
        if not path.startswith("/api/"):
            return await request_route.continue_()
        api_calls.append(path)
        payload = {}
        if path == "/api/health":
            payload = {"ok": True, "api_key": True, "app_server": True, "vibe_cli": True, "default_model": "mistral-large-4", "default_agent": "accept-edits", "user": "test", "version": "1.0.0"}
        elif path == "/api/codex/account":
            payload = {"installed": True, "connected": True, "type": "chatgpt", "plan": "plus"}
        elif path == "/api/providers":
            google_row = next(p for p in provider_rows if p["name"] == "google")
            google_row["key"] = {"present": len(key_saves) > 1, "source": "keyring" if len(key_saves) > 1 else None}
            payload = {"providers": provider_rows, "presets": PRESETS, "subagents": [], "configPath": "/tmp/vibe/config.toml"}
        elif path == "/api/providers/google/key":
            key_saves.append(request.post_data_json)
            if len(key_saves) == 1:
                return await request_route.fulfill(status=503, json={"detail": "Fixture keyring is locked"})
            payload = {"key": {"present": True, "source": "keyring"}}
        elif path == "/api/providers/google/catalog":
            payload = {"models": [{"id": "gemini-fixture", "name": "Gemini fixture"}]}
        elif path == "/api/providers/google/models":
            model_saves.append(request.post_data_json)
            if len(model_saves) == 1:
                return await request_route.fulfill(status=409, json={"detail": "Fixture config is busy"})
            next(p for p in provider_rows if p["name"] == "google")["models"].append(request.post_data_json)
            payload = {"providers": provider_rows, "presets": PRESETS, "subagents": [], "configPath": "/tmp/vibe/config.toml"}
        elif path.startswith("/api/providers/google/models/") and request.method == "DELETE":
            next(p for p in provider_rows if p["name"] == "google")["models"].clear()
            payload = {"providers": provider_rows, "presets": PRESETS, "subagents": [], "configPath": "/tmp/vibe/config.toml"}
        elif path == "/api/settings/api-key":
            payload = {"present": True, "source": "keyring"}
        elif path == "/api/config":
            if request.method == "PATCH":
                config_saves.append(request.post_data_json)
                config.update(request.post_data_json)
            payload = config
        elif path == "/api/sessions":
            if request.method == "POST":
                body = request.post_data_json
                session_creations.append(body)
                payload = {"title": "Retry fixture", "costs": {}, "updated_at": time.time(), "created_at": time.time(),
                           **body, "id": f"retry-{len(session_creations)}", "status": "idle"}
                sessions.append(payload)
            else:
                payload = {"sessions": sessions}
        elif path == "/api/agents/settings":
            if request.method == "GET" and agent_settings_corrupt:
                return await request_route.fulfill(status=409, json={"detail":"Invalid saved settings", "code":"invalid_agent_settings"})
            if request.method == "PUT":
                agent_saves.append(request.post_data_json)
                if len(agent_saves) == 1:
                    return await request_route.fulfill(status=503,json={"detail":"Fixture settings unavailable"})
                agent_settings.update(request.post_data_json)
            payload = agent_settings
        elif path == "/api/agents":
            payload = {"agents": [{"name": "ask", "agentType": "agent", "description": "Requires approval for tool executions"}], "dir": "/tmp/agents"}
        elif path == "/api/audit":
            if audit_unavailable:
                return await request_route.fulfill(status=503, json={"detail": "Fixture audit unavailable"})
            payload = {"audit": []}
        elif path == "/api/skills":
            if skills_unavailable:
                return await request_route.fulfill(status=503, json={"detail": "Fixture skills unavailable"})
            payload = {"skills": skills_rows, "dir": "/tmp/skills", "sharedEnabled": shared_skills}
        elif path == "/api/skills/shared":
            if skills_save_fails:
                return await request_route.fulfill(status=503, json={"detail": "Fixture skill save failed"})
            shared_skills = request.post_data_json["enabled"]
            payload = {"enabled": shared_skills}
        elif path == "/api/mcp":
            if mcp_unavailable:
                return await request_route.fulfill(status=503, json={"detail": "Fixture MCP unavailable"})
            payload = {"servers": [] if mcp_empty else [{"name": "Local research MCP", "command": "fixture-mcp", "transport": "stdio"}]}
        elif path == "/api/workspace/connectors":
            if workspace_unavailable:
                return await request_route.fulfill(status=503, json={"detail": "Fixture workspace unavailable"})
            payload = {"items": [] if workspace_empty else [{"id": "connected", "name": "Research connector", "description": "Configured in Mistral", "connected": True}]}
        elif path == "/api/workspace/libraries":
            if request.method == "POST":
                library_attempts.append(request.post_data_json)
                if len(library_attempts) == 1:
                    return await request_route.fulfill(status=503, json={"detail": "Refresh Libraries before trying again."})
                library_saves.append(request.post_data_json)
                payload = {"id": "created-library", **request.post_data_json, "documents": 0}
            else:
                payload = {"items": [{"id": "library", "name": "Research library", "description": "Shared references", "documents": 3}] +
                           [{"id": "created-library", **entry, "documents": 0} for entry in library_saves]}
        elif path == "/api/projects":
            payload = {"home": "/tmp", "known": [{"name": "Example project", "path": "/tmp/example"}], "recent": []}
        elif path == "/api/usage":
            payload = {"status": "partial", "source": "admin", "account": {"plan": "Pro", "status": "ready"}, "allowances": [], "billing": None,
                       "local": {"rows": [], "observedSince": None, "historicalTotals": {"estimated_cost_usd": 0}}}
        elif path.endswith("/events"):
            sid = path.split("/")[3]
            snapshot = {"kind": "snapshot", "lastEventId": 7, "session": {"id": sid, "status": {"type": "idle"}},
                        "history": [{"id": f"thought-{sid}", "type": "reasoning", "text": f"Visible reasoning {sid}", "generationStatus": "completed"},
                                    {"id": f"msg-{sid}", "type": "message", "role": "assistant", "content": [{"type": "text", "text": f"History {sid}"}]}],
                        "activeCallbacks": [question] if sid == "a" else [], "historyBeforeCursor": "older" if sid == "a" else None}
            return await request_route.fulfill(status=200, content_type="text/event-stream", body=f"data: {json.dumps(snapshot)}\n\n")
        elif path.endswith("/history"):
            payload = {"history": [{"id": "older", "type": "message", "role": "user", "content": [{"type": "text", "text": "Earlier message"}]}], "historyBeforeCursor": None}
        elif "/callbacks/" in path:
            callbacks.append(request.post_data_json)
            payload = {"ok": True}
        elif path.endswith("/release"):
            payload = {"ok": True, "resumeId": "native-unified"}
        elif path.endswith("/turns"):
            turn_attempts.append(request.post_data_json)
            return await request_route.fulfill(status=503, json={"detail": "Fixture first message failed"})
        elif path.startswith("/api/sessions/") and request.method == "DELETE":
            sid = path.split("/")[3]
            if sid == "a" and not deletion_failures:
                deletion_failures.append(sid)
                return await request_route.fulfill(status=503, json={"detail": "Fixture deletion failed"})
            sessions[:] = [s for s in sessions if s["id"] != sid]
            payload = {"ok": True}
        elif path.startswith("/api/sessions/"):
            payload = next(s for s in sessions if s["id"] == path.split("/")[3])
            if request.method == "PATCH":
                session_patches.append(request.post_data_json)
                if payload["status"] in ("running", "blocked", "unknown"):
                    return await request_route.fulfill(status=409, json={"detail": "Wait for this session to become idle"})
                payload.update(request.post_data_json)
        elif path == "/api/studio/models":
            payload = {"models": [{"id": "mistral-large-4", "name": "Mistral Large"}]}
        elif path == "/api/chat":
            chats.append(request.post_data_json)
            return await request_route.fulfill(status=200, content_type="text/event-stream", body='data: {"stream":"think","delta":"Reason"}\n\ndata: {"stream":"text","delta":"Reply"}\n\ndata: [DONE]\n\n')
        else:
            raise AssertionError(f"Unexpected API call {path}")
        await request_route.fulfill(status=200, json=payload)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=os.environ.get("VIBEDECK_CHROME", "/usr/bin/google-chrome"), headless=True, args=["--no-sandbox"])
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        await context.route("**/*", route)
        await context.add_init_script('''window.usageConnected = false; window.usagePercent = 25;
window.vibedeck = { platform: "linux", getZoom: async () => Number(localStorage.getItem("fixture.zoom") || 1), setZoom: async value => { localStorage.setItem("fixture.zoom",String(value)); return value; }, getState: async () => ({ maximized: false }), onState: () => () => {}, minimize: async () => {}, toggleMaximize: async () => {}, close: async () => {}, pickDirectory: async () => null, usage: {
 account: async () => ({remembered:window.usageConnected}),
 connect: async () => { window.usageConnected = true; window.dispatchEvent(new Event('focus')); return true; },
 disconnect: async () => { if (window.failDisconnect) throw new Error('Fixture disconnect failed'); window.usageConnected = false; },
 read: async () => ({ status: window.usageConnected ? 'ready' : 'disconnected', source: 'web', billing: null,
 allowances: window.usageConnected ? [{ id:'vibe_budget',label:'Vibe Code',usedPercent:window.usagePercent,used:window.usagePercent,limit:100,remaining:100-window.usagePercent,currency:'USD',resetAt:'2026-11-01T00:00:00Z' }] : [] })
}};''')
        page = await context.new_page()
        page.set_default_timeout(10000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" and not any(status in message.text for status in ("status of 503", "status of 409")) else None)
        await page.goto(base + "/usage")
        await expect(page.get_by_role("dialog", name="Welcome to VibeDeck")).to_be_visible()
        await page.get_by_role("button", name="Set up later", exact=True).click()
        await page.reload()
        await expect(page.get_by_role("dialog", name="Welcome to VibeDeck")).to_have_count(0)
        await expect(page.get_by_role("heading", name="Usage", exact=True)).to_be_visible()
        await page.get_by_role("button", name="Account", exact=True).click()
        account_menu = page.get_by_role("navigation", name="Account menu", exact=True)
        assert await account_menu.get_by_role("link").all_text_contents() == ["Usage", "API keys", "Settings", "API playground", "Skills", "MCP", "Mistral workspace"]
        await account_menu.evaluate("element => Promise.all(element.getAnimations().map(a => a.finished))")
        await page.screenshot(path=str(artifacts / "account-menu.png"))
        await page.keyboard.press("Escape")
        await expect(account_menu).to_have_count(0)
        await expect(page.get_by_role("button", name="Account", exact=True)).to_be_focused()
        await page.get_by_role("button", name="Account", exact=True).click()
        for _ in range(8):
            await page.keyboard.press("Tab")
        await expect(account_menu).to_have_count(0)
        await page.get_by_role("button", name="Account", exact=True).click()
        await page.get_by_role("button", name="Mistral account", exact=True).click()
        account_dialog = page.get_by_role("dialog", name="Mistral account", exact=True)
        assert await account_dialog.evaluate("e => getComputedStyle(e).animationName") == "vd-reveal"
        await account_dialog.get_by_role("button", name="Sign in to Mistral", exact=True).click()
        await expect(account_dialog).not_to_be_visible()
        await page.get_by_role("button", name="Account", exact=True).click()
        await page.get_by_role("button", name="Mistral account", exact=True).click()
        await expect(account_dialog.get_by_text("Browser sign-in saved", exact=True)).to_be_visible()
        await expect(page.get_by_role("button", name="Account", exact=True)).to_contain_text("test")
        await page.evaluate("window.failDisconnect = true")
        await account_dialog.get_by_role("button", name="Sign out of VibeDeck").click()
        await expect(account_dialog.get_by_role("alert")).to_contain_text("Sign-out failed")
        await expect(account_dialog.get_by_role("button", name="Sign out of VibeDeck")).to_be_enabled()
        await page.evaluate("window.failDisconnect = false")
        await account_dialog.get_by_role("button", name="Sign out of VibeDeck").click()
        await expect(account_dialog.get_by_role("button", name="Sign in to Mistral", exact=True)).to_be_enabled()
        await expect(page.get_by_role("button", name="Account", exact=True)).to_contain_text("Sign in")
        await expect(page.get_by_role("button", name="Account", exact=True)).not_to_contain_text("test")
        await expect(page.get_by_role("progressbar")).to_have_count(0)
        await page.screenshot(path=str(artifacts / "account-controls.png"))
        await page.keyboard.press("Escape")
        await expect(account_dialog).not_to_be_visible()
        await expect(page.get_by_role("button", name="Account", exact=True)).to_be_focused()
        vibe_menu = page.get_by_role("button", name="Vibe menu", exact=True)
        navigation = page.get_by_role("navigation", name="Vibe navigation", exact=True)
        await expect(vibe_menu).to_have_attribute("aria-expanded", "false")
        await vibe_menu.focus()
        await page.keyboard.press("Enter")
        await expect(navigation).to_be_visible()
        await expect(navigation.get_by_role("link", name="Studio", exact=True)).to_have_attribute("href", "https://console.mistral.ai/")
        assert await navigation.get_by_role("link").all_text_contents() == ["Studio", "Docs & API", "Admin"]
        await page.keyboard.press("Tab")
        await expect(navigation.get_by_role("link", name="Studio", exact=True)).to_be_focused()
        await navigation.evaluate("element => Promise.all(element.getAnimations().map(a => a.finished))")
        await page.screenshot(path=str(artifacts / "vibe-navigation.png"))
        await page.keyboard.press("Escape")
        await expect(navigation).to_have_count(0)
        await expect(vibe_menu).to_be_focused()
        await vibe_menu.click()
        await page.get_by_role("heading", name="Usage", exact=True).click()
        await expect(navigation).to_have_count(0)
        for label, target in [("API playground", "/studio/playground"), ("Skills", "/skills"), ("MCP", "/mcp"), ("Settings", "/settings"), ("Usage", "/usage")]:
            await page.get_by_role("button", name="Account", exact=True).click()
            await page.get_by_role("navigation", name="Account menu", exact=True).get_by_role("link", name=label, exact=True).click()
            await expect(page).to_have_url(base + target)
            await expect(vibe_menu).to_have_attribute("aria-expanded", "false")
        await page.goto(base + "/settings")
        await page.get_by_role("button", name="Hide sidebar", exact=True).click()
        await page.wait_for_timeout(250)
        toggle = await page.get_by_role("button", name="Show sidebar", exact=True).bounding_box()
        heading = await page.get_by_role("heading", name="Settings", exact=True).bounding_box()
        assert toggle and heading and toggle["x"] + toggle["width"] <= heading["x"], "Sidebar toggle overlaps heading"
        await page.screenshot(path=str(artifacts / "settings-collapsed.png"))
        await page.get_by_role("button", name="Show sidebar", exact=True).click()
        await page.goto(base + "/usage")
        await vibe_menu.click()
        await page.keyboard.press("Tab")
        for _ in range(await navigation.get_by_role("link").count()):
            await page.keyboard.press("Tab")
        await expect(navigation).to_have_count(0)
        await page.get_by_role("button", name="Connect usage").click()
        await expect(page.get_by_role("progressbar", name="Vibe Code used")).to_have_attribute("aria-valuenow", "25")
        await page.evaluate("window.usagePercent = 60; window.dispatchEvent(new Event('vibedeck:usage-refresh'))")
        await expect(page.get_by_role("progressbar", name="Vibe Code used")).to_have_attribute("aria-valuenow", "60")
        await page.get_by_role("button", name="Account", exact=True).click()
        await page.get_by_role("navigation", name="Account menu", exact=True).get_by_role("link", name="Settings", exact=True).click()
        await page.get_by_role("button", name="Account", exact=True).click()
        await page.get_by_role("navigation", name="Account menu", exact=True).get_by_role("link", name="Usage", exact=True).click()
        await expect(page.get_by_role("progressbar", name="Vibe Code used")).to_have_attribute("aria-valuenow", "60")
        await page.screenshot(path=str(artifacts / "usage-dark.png"))
        await page.evaluate("window.failDisconnect = true")
        await page.get_by_role("button", name="Disconnect usage").click()
        await expect(page.get_by_role("alert")).to_contain_text("Fixture disconnect failed")
        await page.evaluate("window.usagePercent = 65; window.dispatchEvent(new Event('vibedeck:usage-refresh'))")
        await expect(page.get_by_role("progressbar", name="Vibe Code used")).to_have_attribute("aria-valuenow", "65")
        await page.evaluate("window.failDisconnect = false")
        await page.get_by_role("button", name="Disconnect usage").click()
        await expect(page.get_by_role("button", name="Connect usage")).to_be_visible()
        assert await page.get_by_role("progressbar").count() == 0
        await page.evaluate("localStorage.removeItem('vibedeck.mistral-welcome')")
        await page.reload()
        await page.get_by_role("button", name="Sign in to Mistral", exact=True).click()
        await expect(page.get_by_role("dialog", name="Welcome to VibeDeck")).to_have_count(0)
        await expect(page.get_by_role("progressbar", name="Vibe Code used")).to_be_visible()
        await page.goto(base + "/studio/usage")
        await expect(page).to_have_url(base + "/usage")
        catalog_calls = api_calls.count("/api/studio/models")
        await page.goto(base + "/sessions/a")
        await expect(page.get_by_text("History a", exact=True)).to_be_visible()
        await page.get_by_text("Load earlier messages", exact=True).click()
        await expect(page.get_by_text("Earlier message", exact=True)).to_be_visible()
        await page.get_by_label("Desktop", exact=True).check()
        await page.get_by_role("button", name="Submit answers").click()
        assert callbacks[0]["userInput"]["answers"][0]["answer"] == "Desktop"
        await page.get_by_role("button", name="Continue in the vibe CLI").click()
        await expect(page.get_by_text("native-unified", exact=False)).to_be_visible()
        await expect(page.locator("textarea")).to_be_disabled()
        await page.get_by_role("button", name="Continue in desktop").click()
        await expect(page.get_by_text("History a", exact=True)).to_be_visible()
        await page.get_by_role("link", name="Session b", exact=False).click()
        await expect(page.get_by_text("History b", exact=True)).to_be_visible()
        assert await page.get_by_text("History a", exact=True).count() == 0
        assert api_calls.count("/api/studio/models") == catalog_calls
        await page.get_by_role("button", name="Work", exact=True).click()
        context_menu = page.get_by_role("navigation", name="Context", exact=True)
        assert await context_menu.get_by_role("link").all_text_contents() == ["Skills", "Knowledge", "Connectors", "Libraries", "Instructions"]
        motion = await page.evaluate("""async () => {
          const panel = document.querySelector('.context-disclosure');
          const button = document.querySelector('button[aria-controls="sidebar-context"]');
          const sample = async () => {
            const heights = [];
            button.click();
            const start = performance.now();
            while (performance.now() - start < 280) {
              await new Promise(requestAnimationFrame);
              heights.push(panel.getBoundingClientRect().height);
            }
            return heights;
          };
          const closing = await sample();
          const inert = panel.hasAttribute('inert');
          const opening = await sample();
          return { closing, opening, inert };
        }""")
        assert motion["inert"]
        for heights in (motion["closing"], motion["opening"]):
            assert any(1 < height < max(heights) - 1 for height in heights), "Context animation skipped intermediate heights"
        assert motion["closing"][-1] == 0 and motion["opening"][-1] > 0
        (artifacts / "context-animation.json").write_text(json.dumps(motion, indent=2))
        await page.get_by_role("button", name="Context", exact=True).click()
        await expect(context_menu).to_have_count(0)
        await page.reload()
        await expect(context_menu).to_have_count(0)
        await page.get_by_role("button", name="Context", exact=True).click()
        for label in ("Skills", "Knowledge", "Connectors", "Libraries", "Instructions", "Scheduled"):
            link = page.get_by_role("link", name=label, exact=True)
            await expect(link).to_have_attribute("href", "/workspace/" + label.lower())
            await link.click()
            await expect(page.get_by_role("heading", name=label, exact=True)).to_be_visible()
            await expect(page.get_by_role("navigation", name="Context", exact=True)).to_have_count(0)
            await expect(page.get_by_text("The integrated Mistral workspace requires", exact=False)).to_be_visible()
            await page.get_by_role("button", name="Back to desktop", exact=True).click()
            await expect(context_menu).to_be_visible()
        await page.goto(base + "/scheduled")
        await expect(page.get_by_role("heading", name="Scheduled", exact=True)).to_be_visible()
        await expect(page.get_by_role("link", name="Open Mistral Tasks")).to_have_attribute("href", "https://chat.mistral.ai/tasks")
        await page.goto(base + "/connectors")
        await expect(page.get_by_text("Research connector", exact=True)).to_be_visible()
        await expect(page.get_by_text("Connected via API", exact=True)).to_be_visible()
        await expect(page.get_by_text("Missing entries here do not mean they are disconnected on the web.", exact=False)).to_be_visible()
        await expect(page.get_by_role("region", name="Local CLI connectors").get_by_text("Local research MCP", exact=True)).to_be_visible()
        await expect(page.get_by_role("link", name="Open Mistral Connectors")).to_have_attribute("href", "https://chat.mistral.ai/connections")
        await page.get_by_role("textbox", name="Search connectors").fill("missing")
        await expect(page.get_by_text("No matching items.", exact=True)).to_be_visible()
        await page.get_by_role("textbox", name="Search connectors").fill("")
        workspace_unavailable = True
        await page.get_by_role("button", name="Refresh", exact=True).click()
        await expect(page.get_by_role("alert")).to_contain_text("Fixture workspace unavailable")
        await expect(page.get_by_text("Local research MCP", exact=True)).to_be_visible()
        assert await page.get_by_text("No authenticated external connectors returned", exact=False).count() == 0
        workspace_unavailable = False
        await page.get_by_role("button", name="Refresh", exact=True).click()
        await expect(page.get_by_text("Research connector", exact=True)).to_be_visible()
        await expect(page.get_by_role("alert")).to_have_count(0)
        workspace_empty = True
        await page.get_by_role("button", name="Refresh", exact=True).click()
        await expect(page.get_by_text("0 API-visible connectors", exact=True)).to_be_visible()
        await expect(page.get_by_text("Your web connections may still be active.", exact=False)).to_be_visible()
        await expect(page.get_by_text("Connected via API", exact=True)).to_have_count(0)
        workspace_empty = False
        await page.get_by_role("button", name="Refresh", exact=True).click()
        await expect(page.get_by_text("Research connector", exact=True)).to_be_visible()
        await page.screenshot(path=str(artifacts / "connectors.png"))
        await page.goto(base + "/workspace/connectors")
        await page.get_by_role("button", name="Show local CLI connectors", exact=True).click()
        await expect(page.get_by_text("Local research MCP", exact=True)).to_be_visible()
        await page.get_by_role("button", name="Refresh local CLI connectors", exact=True).click()
        await expect(page.get_by_text("Local research MCP", exact=True)).to_be_visible()
        await page.get_by_role("button", name="Show Mistral web connectors", exact=True).click()
        await expect(page.get_by_role("region", name="Local CLI connectors")).to_have_count(0)
        await page.goto(base + "/libraries")
        await expect(page.get_by_text("Research library", exact=True)).to_be_visible()
        await expect(page.get_by_text("3 documents", exact=True)).to_be_visible()
        await page.get_by_role("button", name="New library", exact=True).click()
        await page.get_by_role("textbox", name="Library name", exact=True).fill("Shared desktop research")
        await page.get_by_role("textbox", name="Description", exact=True).fill("Same workspace")
        await page.get_by_role("button", name="Create shared library", exact=True).click()
        await expect(page.get_by_role("alert")).to_contain_text("Refresh Libraries before trying again.")
        await expect(page.get_by_role("textbox", name="Library name", exact=True)).to_have_value("Shared desktop research")
        assert library_saves == []
        await page.get_by_role("button", name="Refresh", exact=True).click()
        await expect(page.get_by_role("button", name="Refresh", exact=True)).to_be_enabled()
        await page.get_by_role("button", name="Create shared library", exact=True).click()
        await expect(page.get_by_role("link", name="Open created library in Mistral", exact=True)).to_have_attribute("href", "https://chat.mistral.ai/libraries/created-library")
        await expect(page.get_by_text("Shared desktop research", exact=True)).to_be_visible()
        assert library_saves == [{"name": "Shared desktop research", "description": "Same workspace"}]
        assert len(library_attempts) == 2
        await page.screenshot(path=str(artifacts / "libraries.png"))
        await expect(page.get_by_role("link", name="Scheduled", exact=True)).to_have_attribute("href", "/workspace/scheduled")
        await page.goto(base + "/scheduled")
        await expect(page.get_by_role("heading", name="Scheduled", exact=True)).to_be_visible()
        await page.get_by_role("link", name="Example project", exact=True).click()
        await expect(page).to_have_url(base + "/?project=%2Ftmp%2Fexample")
        await expect(page.get_by_role("button", name="Select project directory", exact=True)).to_have_text("example")
        await page.locator(".vd-reveal").evaluate_all("elements => Promise.all(elements.flatMap(e => e.getAnimations()).map(a => a.finished))")
        assert await page.locator('[data-vd-titlebar]').inner_text() == "", "Duplicate title-bar branding"
        for width, height in ((1440, 900), (1000, 760), (760, 600)):
            await page.set_viewport_size({"width": width, "height": height})
            heading = await page.locator('h1').bounding_box()
            assert heading and heading["y"] > height * .2, "Welcome content is pinned to the top"
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Welcome overflow"
        await page.set_viewport_size({"width": 1440, "height": 900})
        await page.screenshot(path=str(artifacts / "work-welcome.png"))
        await page.goto(base + "/sessions/w")
        await expect(page.get_by_text("Visible reasoning w", exact=True)).to_be_visible()
        thought = page.get_by_role("button", name="Thought process", exact=True)
        await expect(thought).to_have_attribute("aria-expanded", "true")
        await thought.click()
        await expect(page.get_by_text("Visible reasoning w", exact=True)).to_have_count(0)
        await thought.click()
        await page.screenshot(path=str(artifacts / "work-thinking.png"))
        await page.goto(base + "/sessions/b")
        await expect(page.get_by_role("button", name="Thought process", exact=True)).to_have_attribute("aria-expanded", "false")
        await page.get_by_role("button", name="Code", exact=True).click()
        await expect(context_menu.get_by_role("link", name="Knowledge", exact=True)).to_have_count(0)
        await page.get_by_role("link", name="Extensions", exact=True).click()
        await expect(page.get_by_role("heading", name="Extensions", exact=True)).to_be_visible()
        await page.get_by_text("Advanced", exact=True).click()
        await expect(page.get_by_role("link", name="CLI configuration", exact=True)).to_be_visible()
        await page.get_by_role("button", name="Copy 2. Set up Vibe CLI", exact=True).click()
        await expect(page.get_by_text("Copied", exact=True)).to_be_visible()
        await expect(page.get_by_role("link", name="Visual Studio Code", exact=False)).to_have_attribute("href", "https://docs.mistral.ai/vibe/code/vs-code-extension/install-authenticate")
        await page.screenshot(path=str(artifacts / "extensions.png"))
        for width, height in ((760, 600), (1440, 900)):
            await page.set_viewport_size({"width": width, "height": height})
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            await expect(page.get_by_role("heading", name="Extensions", exact=True)).to_be_visible()
            await page.screenshot(path=str(artifacts / f"extensions-{width}.png"))
        await page.goto(base + "/studio/playground")
        await page.get_by_role("spinbutton", name="Top P", exact=True).fill("0.8")
        await page.get_by_role("spinbutton", name="Random seed", exact=True).fill("17")
        await page.get_by_role("spinbutton", name="Presence penalty", exact=True).fill("0.2")
        await page.get_by_role("spinbutton", name="Frequency penalty", exact=True).fill("0.4")
        await page.get_by_role("textbox", name="Stop sequences", exact=True).fill("END\nSTOP")
        await page.get_by_role("checkbox", name="JSON output", exact=True).check()
        await page.get_by_role("checkbox", name="Mistral safety prompt", exact=True).check()
        assert chats == [], "Parameter changes must never make completions"
        await page.get_by_role("button", name="Parameters", exact=True).click()
        await expect(page.get_by_role("spinbutton", name="Top P", exact=True)).to_have_count(0)
        await page.get_by_role("button", name="Parameters", exact=True).click()
        await expect(page.get_by_role("spinbutton", name="Top P", exact=True)).to_have_value("0.8")
        for width, height in ((960, 600), (1440, 900)):
            await page.set_viewport_size({"width": width, "height": height})
            await page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            await page.screenshot(path=str(artifacts / f"studio-parameters-{width}.png"))
        for prompt in ("First", "Second"):
            await page.get_by_role("textbox", name="Playground message", exact=True).fill(prompt)
            await page.get_by_role("button", name="Send", exact=True).click()
            await expect(page.get_by_role("button", name="Send", exact=True)).to_be_visible()
        assert chats[0]["messages"] == []
        assert {field: chats[0][field] for field in ("top_p", "random_seed", "presence_penalty", "frequency_penalty", "stop", "json_mode", "safe_prompt")} == {"top_p": .8, "random_seed": 17, "presence_penalty": .2, "frequency_penalty": .4, "stop": ["END", "STOP"], "json_mode": True, "safe_prompt": True}
        await page.get_by_role("button", name="Clear", exact=True).click()
        await expect(page.get_by_text("Studio Playground — pick a model and send a prompt.", exact=True)).to_be_visible()
        studio_menu = page.get_by_role("navigation", name="Studio sections")
        for section in ("Models", "Agents", "Observability"):
            await studio_menu.get_by_role("link", name=section, exact=True).click()
            await expect(page.get_by_role("heading", name=section, exact=True)).to_be_visible()
        assert chats[1]["messages"] == [{"role": "user", "content": "First"}, {"role": "assistant", "content": "Reply"}]
        await page.goto(base + "/settings")
        await expect(page.get_by_role("heading", name="Settings", exact=True)).to_be_visible()
        assert await page.title() == "Vibe"
        assert await page.locator("vite-error-overlay").count() == 0
        menu = page.get_by_role("navigation", name="Settings sections")
        await expect(menu.get_by_role("link", name="Providers", exact=True)).to_have_attribute("aria-current", "page")
        assert await page.get_by_role("combobox", name="Default model", exact=True).count() == 0
        google = page.get_by_role("button", name="Google AI Studio", exact=True)
        assert await google.evaluate("e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }")
        await page.screenshot(path=str(artifacts / "providers-settings.png"))
        await google.click()
        await expect(page.get_by_role("combobox", name="Provider service")).to_have_value("google")
        await page.get_by_text("Connection settings", exact=True).click()
        await expect(page.get_by_placeholder("key env var (e.g. OPENAI_API_KEY)")).to_have_value("GEMINI_API_KEY")
        await expect(page.get_by_role("link", name="Get a Google AI Studio API key", exact=True)).to_have_attribute("href", "https://aistudio.google.com/apikey")
        await page.screenshot(path=str(artifacts / "google-provider.png"))
        await page.get_by_role("button", name="Cancel", exact=True).click()
        await page.get_by_role("button", name="Manage Google AI Studio", exact=True).click()
        key_input = page.get_by_placeholder("Paste API key…", exact=True)
        await key_input.fill("local-fixture-key")
        await page.get_by_role("button", name="Save key", exact=True).click()
        await expect(page.get_by_text("Fixture keyring is locked", exact=False)).to_be_visible()
        await expect(key_input).to_have_value("local-fixture-key")
        await page.get_by_role("button", name="Save key", exact=True).click()
        await expect(page.get_by_placeholder("Replace key…", exact=True)).to_have_value("")
        google_connection = page.get_by_role("region", name="Google AI Studio connection", exact=True)
        await google_connection.get_by_role("button", name="Remove provider", exact=True).click()
        await expect(google_connection.get_by_text("Remove this provider, its registered models and its saved key?")).to_be_visible()
        await google_connection.get_by_role("button", name="Cancel", exact=True).click()
        await page.get_by_role("button", name="Manage Codex / ChatGPT", exact=True).click()
        await expect(page.get_by_text("Connected · chatgpt", exact=True)).to_be_visible()
        assert await page.get_by_role("region", name="Codex / ChatGPT connection", exact=True).get_by_role("button", name="Save key", exact=True).count() == 0
        await page.get_by_role("button", name="Add provider", exact=True).click()
        preset_select = page.get_by_role("combobox", name="Provider service")
        for preset in PRESETS:
            await preset_select.select_option(preset["name"])
            await expect(page.get_by_placeholder("name (e.g. openai)")).to_have_value(preset["name"])
            await expect(page.get_by_placeholder("https://api.openai.com/v1", exact=True)).to_have_value(preset["api_base"])
        await page.get_by_role("button", name="Cancel", exact=True).click()
        await menu.get_by_role("link", name="Models", exact=True).click()
        await expect(page.get_by_role("combobox", name="Default model", exact=True)).to_be_visible()
        assert await page.get_by_role("button", name="Save key", exact=True).count() == 0
        google_models = page.get_by_role("region", name="Google AI Studio models", exact=True)
        await google_models.get_by_role("button", name="Load models", exact=True).click()
        await google_models.get_by_label("Available models", exact=True).select_option("gemini-fixture")
        await expect(google_models.get_by_placeholder("Name shown in the model picker")).to_have_value("google-gemini-fixture")
        await google_models.get_by_role("button", name="Save model", exact=True).click()
        await expect(google_models.get_by_text("Fixture config is busy", exact=False)).to_be_visible()
        await expect(google_models.get_by_placeholder("Model ID from provider")).to_have_value("gemini-fixture")
        await google_models.get_by_role("button", name="Save model", exact=True).click()
        await expect(google_models.get_by_text("google-gemini-fixture", exact=True)).to_be_visible()
        assert model_saves == [{"name": "gemini-fixture", "alias": "google-gemini-fixture"}] * 2
        await page.get_by_role("button", name="Save defaults", exact=True).click()
        await expect(page.get_by_role("button", name="Saved", exact=True)).to_be_visible()
        assert config_saves[-1] == {"defaultModel": "mistral-large-4"}
        await page.screenshot(path=str(artifacts / "models-settings.png"))
        await google_models.get_by_role("button", name="Remove model google-gemini-fixture", exact=True).click()
        await expect(google_models.get_by_text("google-gemini-fixture", exact=True)).to_have_count(0)
        await menu.get_by_role("link", name="Config", exact=True).click()
        await expect(page.get_by_text("Appearance", exact=True)).to_be_visible()
        await expect(page.get_by_role("combobox", name="Default agent mode")).to_be_visible()
        await page.get_by_role("combobox",name="Subagent delegation",exact=True).select_option("auto")
        await page.get_by_role("combobox",name="Subagent quality",exact=True).select_option("strong")
        await page.get_by_role("combobox",name="Subagent worker limit",exact=True).select_option("3")
        await page.get_by_role("button",name="Save subagents",exact=True).click()
        await expect(page.get_by_role("alert")).to_contain_text("Could not save subagent settings")
        await expect(page.get_by_role("combobox",name="Subagent quality",exact=True)).to_have_value("strong")
        await page.get_by_role("button",name="Save subagents",exact=True).click()
        assert agent_saves[-1] == {"policy":"auto","quality":"strong","max_workers":3}
        await expect(page.get_by_role("button",name="Saved",exact=True)).to_be_visible()
        await page.get_by_role("heading",name="Subagents",exact=True).scroll_into_view_if_needed()
        await page.screenshot(path=str(artifacts / "subagent-settings.png"))
        agent_settings_corrupt = True
        await page.reload()
        await expect(page.get_by_role("alert")).to_contain_text("save to repair")
        await expect(page.get_by_role("combobox", name="Subagent delegation", exact=True)).to_have_value("off")
        assert agent_settings["policy"] == "auto", "Recovery defaults must not save without user action"
        await page.get_by_role("button", name="Save subagents", exact=True).click()
        await expect(page.get_by_role("button", name="Saved", exact=True)).to_be_visible()
        assert agent_saves[-1] == {"policy":"off","quality":"balanced","max_workers":2}
        agent_settings_corrupt = False
        await page.reload()
        await expect(page.get_by_role("combobox", name="Subagent delegation", exact=True)).to_have_value("off")

        for theme in ("Forest", "Plum", "High contrast"):
            await page.get_by_role("button", name=theme, exact=True).click()
            await expect(page.get_by_role("button", name=theme, exact=True)).to_have_attribute("aria-pressed", "true")
        await page.get_by_role("button", name="Dark", exact=True).click()
        await page.get_by_role("combobox", name="App zoom", exact=True).select_option("1.25")
        await expect(page.get_by_role("combobox", name="App zoom", exact=True)).to_be_enabled()
        await page.reload()
        await expect(page.get_by_role("combobox", name="App zoom", exact=True)).to_have_value("1.25")
        await page.get_by_role("combobox", name="App zoom", exact=True).select_option("1")

        await page.get_by_role("button", name="Dark", exact=True).scroll_into_view_if_needed()
        await page.screenshot(path=str(artifacts / "appearance-settings.png"))
        assert await page.get_by_role("button", name="Google AI Studio", exact=True).count() == 0
        await page.get_by_role("combobox", name="Default agent mode").select_option("plan")
        await page.get_by_role("button", name="Save defaults", exact=True).click()
        await expect(page.get_by_role("button", name="Saved", exact=True)).to_be_visible()
        assert config_saves[-1] == {"defaultAgent": "plan", "defaultReasoning": None}
        await page.screenshot(path=str(artifacts / "config-settings.png"))
        await page.go_back()
        await expect(menu.get_by_role("link", name="Models", exact=True)).to_have_attribute("aria-current", "page")
        await page.reload()
        await expect(page.get_by_role("combobox", name="Default model", exact=True)).to_be_visible()
        for width, height in ((960, 600), (1000, 760), (1920, 1080)):
            await page.set_viewport_size({"width": width, "height": height})
            for section in ("Providers", "Models", "Config"):
                await menu.get_by_role("link", name=section, exact=True).click()
                await expect(menu.get_by_role("link", name=section, exact=True)).to_have_attribute("aria-current", "page")
                if section == "Config":
                    await expect(page.get_by_text("Appearance", exact=True)).to_be_visible()
                else:
                    await expect(page.get_by_role("region", name=f"Mistral {'connection' if section == 'Providers' else 'models'}", exact=True)).to_be_visible()
                await page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), (width, section, "Horizontal overflow")
                assert await page.locator(".settings-page button").evaluate_all("nodes => nodes.filter(e => e.offsetParent && getComputedStyle(e).whiteSpace === 'nowrap').every(e => e.scrollWidth <= e.clientWidth + 1)"), (width, section, "Clipped button")
                await page.screenshot(path=str(artifacts / f"settings-{section.lower()}-{width}.png"))
        await page.get_by_role("button", name="Delete all", exact=True).click()
        await page.get_by_role("button", name="Confirm delete", exact=True).click()
        await expect(page.get_by_role("alert")).to_contain_text("1 session(s) could not be deleted")
        await page.get_by_role("button", name="Confirm delete", exact=True).click()
        await expect(page.get_by_text("deleted", exact=True)).to_be_visible()
        await page.goto(base)
        await page.get_by_role("button", name="Code", exact=True).click()
        await expect(page.get_by_role("button", name="Select agent", exact=True)).to_contain_text("Plan")
        for mode in ("Full auto","Accept edits","Ask","Plan"):
            await page.get_by_role("button",name="Select agent",exact=True).click()
            await page.get_by_role("button",name=mode,exact=True).click()
            await expect(page.get_by_role("button",name="Select agent",exact=True)).to_contain_text(mode)

        await page.goto(base + "/settings")
        await menu.get_by_role("link", name="Providers", exact=True).click()
        await page.emulate_media(reduced_motion="reduce")
        duration = await page.locator("button").first.evaluate("e => getComputedStyle(e).transitionDuration")
        assert all(float(v.strip().removesuffix('s')) < .001 for v in duration.split(',')), duration
        assert await page.evaluate("""() => {
          const dots = document.createElement('div'); dots.className = 'vd-dots'; dots.id = 'motion-check';
          dots.innerHTML = '<span></span><span></span><span></span>'; document.body.append(dots);
          return [...dots.children].every(e => {
            const style = getComputedStyle(e);
            return style.animationIterationCount === '1' && style.animationDelay === '0s';
          });
        }"""), "Reduced motion left the working indicator looping"
        try:
            await page.wait_for_function("""() =>
              document.querySelector('#motion-check').getAnimations({subtree:true})
                .every(animation => animation.playState === 'finished')
            """, timeout=3000)
        finally:
            await page.locator("#motion-check").evaluate("element => element.remove()")
        await page.set_viewport_size({"width": 1000, "height": 760})
        await page.screenshot(path=str(artifacts / "settings-compact.png"))
        assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Horizontal overflow"
        config["defaultAgent"] = "accept-edits"
        config["vibeModels"].append({"id": "audit-b", "name": "audit-b", "supportsImages": True, "thinkingLevels": []})
        await page.goto(base)
        composer = page.locator("[data-vd-composer]")
        await composer.fill("Retry with image")
        await page.locator('input[type="file"]').set_input_files({"name": "pixel.png", "mimeType": "image/png", "buffer": b"fixture-image"})
        await page.get_by_role("button", name="Send", exact=True).click()
        await expect(page.get_by_role("alert")).to_have_count(1)
        await expect(page.get_by_role("alert")).to_contain_text("Fixture first message failed")
        await expect(page.get_by_role("button", name="Remove pixel.png", exact=True)).to_be_visible()
        await page.get_by_role("button", name="Select model", exact=True).click()
        await page.get_by_role("button", name="audit-b", exact=False).click()
        await page.get_by_role("button", name="Select agent", exact=True).click()
        await page.get_by_role("button", name="Plan", exact=True).click()
        await page.get_by_role("button", name="Send", exact=True).click()
        await expect(page.get_by_role("alert")).to_contain_text("Fixture first message failed")
        assert len(session_creations) == 1 and len(turn_attempts) == 2
        assert session_patches == [{"agent": "plan", "model": "audit-b"}]
        assert turn_attempts[0]["requestId"] == turn_attempts[1]["requestId"]
        assert turn_attempts[0]["images"] == turn_attempts[1]["images"]
        sessions[-1]["status"] = "unknown"
        await page.get_by_role("button", name="Select agent", exact=True).click()
        await page.get_by_role("button", name="Ask", exact=True).click()
        await page.get_by_role("button", name="Send", exact=True).click()
        await expect(page.get_by_role("alert")).to_contain_text("become idle")
        assert len(turn_attempts) == 2
        await page.get_by_role("button", name="Work", exact=True).click()
        await page.get_by_role("button", name="Send", exact=True).click()
        await expect(page.get_by_role("alert")).to_contain_text("another project or mode")
        assert len(turn_attempts) == 2
        await page.get_by_role("button", name="Start new session", exact=True).click()
        await expect(composer).to_have_value("Retry with image")
        await expect(page.get_by_role("button", name="Remove pixel.png", exact=True)).to_be_visible()
        assert len(session_creations) == 1 and len(turn_attempts) == 2
        await composer.fill("Review ")
        await composer.press("/")
        await expect(composer).to_have_value("Review /")
        await expect(page.get_by_role("textbox", name="Command palette", exact=True)).to_have_count(0)
        await composer.fill("")
        await composer.press("/")
        await expect(page.get_by_role("textbox", name="Command palette", exact=True)).to_be_visible()
        await page.keyboard.press("Escape")
        await page.keyboard.press("Control+k")
        await page.get_by_role("textbox", name="Command palette", exact=True).fill("Knowledge")
        await page.get_by_role("button", name="Knowledge", exact=True).click()
        await expect(page).to_have_url(base + "/workspace/knowledge")
        mcp_unavailable = True
        skills_unavailable = True
        await page.goto(base + "/skills")
        await expect(page.get_by_role("alert")).to_contain_text("Could not load CLI skills")
        await expect(page.get_by_text("No skills found.", exact=True)).to_have_count(0)
        shared = page.get_by_role("checkbox", name="Use shared Mistral workspace skills in the CLI and desktop")
        await expect(shared).to_be_disabled()
        skills_unavailable = False
        skills_rows = [{"name": "Fixture review skill", "path": "/tmp/skills/fixture/SKILL.md"}]
        await page.get_by_role("button", name="Retry loading skills", exact=True).click()
        await expect(page.get_by_text("Fixture review skill", exact=True)).to_be_visible()
        skills_save_fails = True
        await shared.check()
        await expect(page.get_by_role("alert")).to_contain_text("Could not save shared skills")
        await expect(shared).not_to_be_checked()
        skills_save_fails = False
        await page.get_by_role("button", name="Retry loading skills", exact=True).click()
        await expect(shared).to_be_enabled()
        await shared.check()
        await expect(shared).to_be_enabled()
        assert shared_skills is True
        await page.get_by_role("button", name="Refresh skills", exact=True).click()
        await expect(shared).to_be_checked()
        await page.get_by_placeholder("Filter skills…").fill("missing")
        await expect(page.get_by_text("No matching skills.", exact=True)).to_be_visible()
        await page.goto(base + "/mcp")
        await expect(page.get_by_role("alert")).to_contain_text("Fixture MCP unavailable")
        await expect(page.get_by_text("No MCP servers configured.", exact=False)).to_have_count(0)
        mcp_unavailable = False
        mcp_empty = True
        await page.get_by_role("button", name="Retry loading MCP servers", exact=True).click()
        await expect(page.get_by_role("alert")).to_have_count(0)
        await expect(page.get_by_text("No MCP servers configured.", exact=False)).to_be_visible()
        audit_unavailable = True
        await page.goto(base + "/studio/observability")
        await expect(page.get_by_role("alert")).to_contain_text("audit events")
        await expect(page.get_by_text("No audit events.", exact=True)).to_have_count(0)
        audit_unavailable = False
        await page.get_by_role("button", name="Retry", exact=True).click()
        await expect(page.get_by_text("No audit events.", exact=True)).to_be_visible()
        await page.get_by_role("link", name="Models", exact=True).click()
        await expect(page.get_by_role("cell", name="mistral-large-4", exact=True)).to_be_visible()
        await page.get_by_placeholder("Filter models…").fill("missing")
        await expect(page.get_by_text("No models match.", exact=True)).to_be_visible()
        await page.get_by_placeholder("Filter models…").fill("Mistral Large")
        await expect(page.get_by_role("cell", name="mistral-large-4", exact=True)).to_be_visible()
        await page.get_by_role("link", name="Agents", exact=True).click()
        await expect(page.get_by_role("heading", name="Agents", exact=True)).to_be_visible()
        await expect(page.get_by_text("ask", exact=True).first).to_be_visible()
        await page.goto(base + "/settings")
        await page.emulate_media(reduced_motion="no-preference")
        frames = await page.evaluate("""async () => {
          const samples = []; let last = performance.now();
          await new Promise(resolve => { function tick(now) { samples.push(now-last); last=now; samples.length<90 ? requestAnimationFrame(tick) : resolve(); } requestAnimationFrame(tick); });
          return samples.slice(2).sort((a,b)=>a-b);
        }""")
        metrics = {"frames":len(frames),"p95Ms":round(frames[int(len(frames)*.95)],2),"maxMs":round(max(frames),2)}
        (artifacts / "frame-timing.json").write_text(json.dumps(metrics,indent=2))
        assert metrics["p95Ms"] < 50, metrics
        motion = await page.evaluate("""async () => {
          const samples=[], widths=[]; let last=performance.now(), frame=0;
          await new Promise(resolve => { function tick(now) {
            samples.push(now-last); last=now;
            widths.push(document.querySelector('aside').getBoundingClientRect().width);
            if ([10,35,60,85].includes(frame)) {
              (document.querySelector('button[aria-label="Show sidebar"]') || document.querySelector('button[aria-label="Hide sidebar"]')).click();
            }
            ++frame<120 ? requestAnimationFrame(tick) : resolve();
          } requestAnimationFrame(tick); });
          samples.splice(0,2); samples.sort((a,b)=>a-b);
          return {p95Ms:samples[Math.floor(samples.length*.95)],maxMs:Math.max(...samples),widthRange:Math.max(...widths)-Math.min(...widths)};
        }""")
        assert motion["widthRange"] > 200 and motion["p95Ms"] < 50, motion
        (artifacts / "sidebar-animation.json").write_text(json.dumps(motion,indent=2))
        assert not errors, errors
        assert not external, external
        await browser.close()
    server.shutdown()
    print("PASS: Vibe dropdown/keyboard, Context tree and projects, hosted workspace routes, configured connectors, shared library creation, Work thinking defaults, Extensions/copy/compact layout, first-run browser prompt, usage refresh, history/callbacks/CLI handoff, session switching, Studio, provider/settings error recovery, reduced motion, sidebar animation; no external requests")


if __name__ == "__main__":
    asyncio.run(run())
