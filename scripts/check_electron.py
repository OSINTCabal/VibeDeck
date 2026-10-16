"""Opt-in real Electron smoke test on an active Linux display; no paid calls.

Uses an isolated profile/database/VIBE_HOME and the local model from the native
interop check. Requires Playwright, Chrome/Electron and the installed Vibe CLI.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

import playwright
from check_native_interop import MockModel

ROOT = Path(__file__).resolve().parents[1]


def run():
    artifacts = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/vibedeck-electron").resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="vibedeck-electron-") as temporary:
        home = Path(temporary)
        model = ThreadingHTTPServer(("127.0.0.1", 0), MockModel)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        (home / "config.toml").write_text(f'''active_model = "local"
default_agent = "ask"
console_base_url = "http://127.0.0.1:{model.server_port}"
vibe_base_url = "http://127.0.0.1:{model.server_port}"
[[providers]]
name = "local"
api_base = "http://127.0.0.1:{model.server_port}/v1"
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
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = {k: v for k, v in os.environ.items() if not k.startswith("VIBE_") and k not in ("MISTRAL_API_KEY", "MISTRAL_ADMIN_API_KEY")}
        env.update(VIBE_HOME=str(home), VIBEDECK_DATA=str(home / "desktop"), VIBEDECK_PORT=str(port),
                   VIBEDECK_URL=f"http://127.0.0.1:{port}", VIBEDECK_TEST_HOME=str(home),
                   XDG_CONFIG_HOME=str(home / "config"), VIBEDECK_ARTIFACTS=str(artifacts),
                   VIBEDECK_PLAYWRIGHT=str(Path(playwright.__file__).parent / "driver/package"),
                   PYTHON_KEYRING_BACKEND="keyring.backends.null.Keyring", VIBE_TEST_DISABLE_KEYRING="1", DO_NOT_TRACK="1")
        with (artifacts / "electron-sidecar.log").open("w") as log:
            server = subprocess.Popen([sys.executable, "-m", "uvicorn", "vibedeck_server:app", "--app-dir", str(ROOT / "sidecar"),
                                       "--host", "127.0.0.1", "--port", str(port)], env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        with urlopen(env["VIBEDECK_URL"] + "/api/health", timeout=1) as response:
                            assert json.load(response)["ok"]
                        break
                    except OSError:
                        assert server.poll() is None, "Sidecar startup failed; inspect electron-sidecar.log"
                        time.sleep(.1)
                else:
                    raise AssertionError("Sidecar startup timed out")
                subprocess.run(["node", str(ROOT / "scripts/check_electron.cjs")], env=env, check=True, timeout=120)
                assert len(MockModel.requests) == 1, f"Expected one local model request, got {len(MockModel.requests)}"
                print("PASS: isolated Electron workflow; exactly one loopback model call; no paid credentials")
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
                model.shutdown()


if __name__ == "__main__":
    run()
