import os
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize("inherited_key", [None, "original-cli-key"])
def test_launcher_preserves_cli_auth_and_reads_port_after_env(tmp_path, inherited_key):
    app = tmp_path / "app"
    (app / "shell/electron").mkdir(parents=True)
    (app / "sidecar").mkdir()
    (app / "sidecar/vibedeck_server.py").touch()
    config = tmp_path / "config/vibedeck"
    config.mkdir(parents=True)
    (config / "env").write_text('MISTRAL_API_KEY=desktop-only-key\nVIBEDECK_PORT=19999\n')
    commands = tmp_path / "bin"
    commands.mkdir()
    (commands / "curl").write_text('#!/bin/sh\nexit 0\n')
    electron = commands / "electron"
    electron.write_text('#!/bin/sh\nprintf "%s\\n%s\\n%s\\n" "${MISTRAL_API_KEY-unset}" "$VIBEDECK_URL" "$VIBEDECK_DATA"\n')
    for path in commands.iterdir():
        path.chmod(0o755)
    env = {**os.environ, "PATH": f"{commands}:{os.environ['PATH']}", "VIBEDECK_HOME": str(app),
           "VIBEDECK_ELECTRON": str(electron), "XDG_CONFIG_HOME": str(tmp_path / "config"),
           "XDG_DATA_HOME": str(tmp_path / "data")}
    env.pop("VIBEDECK_DATA", None)
    env.pop("MISTRAL_API_KEY", None)
    if inherited_key:
        env["MISTRAL_API_KEY"] = inherited_key
    launcher = Path(__file__).resolve().parents[1] / "packaging/bin/vibedeck"
    result = subprocess.run(["bash", str(launcher)], env=env, capture_output=True, text=True, timeout=5, check=True)
    assert result.stdout.splitlines() == [inherited_key or "unset", "http://127.0.0.1:19999", str(tmp_path / "data/vibedeck")]


def test_installer_reports_missing_prerequisite_before_mutating(tmp_path):
    commands = tmp_path / 'bin'
    commands.mkdir()
    for name in ('dirname', 'python3', 'node'):
        executable = commands / name
        executable.write_text('#!/bin/sh\n' + ('exec /usr/bin/dirname "$@"\n' if name == 'dirname' else 'exit 0\n'))
        executable.chmod(0o755)
    app = tmp_path / 'app'
    env = {**os.environ, 'PATH': str(commands), 'HOME': str(tmp_path), 'VIBEDECK_HOME': str(app)}
    installer = Path(__file__).resolve().parents[1] / 'packaging/install.sh'
    result = subprocess.run(['/bin/bash', str(installer)], env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode == 1 and 'Missing npm' in result.stderr
    assert not app.exists()
