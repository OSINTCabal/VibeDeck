"""Vibe CLI version, release notes and model-defined thinking levels."""
import pytest
import vibe_install
import vibedeck_server
from fastapi.testclient import TestClient
from vibe_bridge import valid_reasoning


def _install(tmp_path, version, notes=None):
    """A uv-tool-like environment: bin/vibe-app-server + site-packages/vibe."""
    env = tmp_path / f"vibe-{version}"
    pkg = env / "lib" / "python3.14" / "site-packages" / "vibe"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text(f'__version__ = "{version}"\n')
    for name, text in (notes or {}).items():
        path = pkg / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    (env / "bin").mkdir()
    server = env / "bin" / "vibe-app-server"
    server.write_text("#!/bin/sh\n")
    return str(server)


def test_version_from_package(tmp_path):
    server = _install(tmp_path, "3.0.3")
    info = vibe_install.info(server)
    assert info["version"] == "3.0.3"
    assert info["outdated"] is True
    assert info["upgradeCommand"] == "uv tool upgrade mistral-vibe"
    assert vibe_install.info(_install(tmp_path, "3.1.0"))["outdated"] is False


def test_missing_server_has_no_version():
    assert vibe_install.info("mock-vibe-app-server") == {
        "version": None, "recommended": "3.0.4", "outdated": False,
        "upgradeCommand": "uv tool upgrade mistral-vibe"}
    assert vibe_install.release_notes(None) == []


def test_release_notes_newest_first(tmp_path):
    server = _install(tmp_path, "3.0.4", {
        "whats_new.md": "# What's new in v3.0.4\n\n- Release notes view\n",
        "release_notes/3.0.2.md": "# What's new in v3.0.2\n\n- Older\n",
        "release_notes/3.0.4.md": "# duplicate of whats_new\n",
        "release_notes/3.0.10.md": "# What's new in v3.0.10\n",
    })
    notes = vibe_install.release_notes(server)
    assert [n["version"] for n in notes] == ["3.0.10", "3.0.4", "3.0.2"]
    assert "Release notes view" in notes[1]["markdown"]


@pytest.mark.parametrize("level,ok", [
    ("high", True), ("off", True), ("turbo", True), ("minimal", True), ("x-high_2", True),
    ("", False), ("High", False), ("two words", False), ("-low", False), ("a" * 33, False),
])
def test_reasoning_accepts_model_defined_words(level, ok):
    assert valid_reasoning(level) is ok


def test_api_reports_vibe_and_accepts_custom_level(monkeypatch, tmp_path):
    server = _install(tmp_path, "3.0.4", {"whats_new.md": "# What's new in v3.0.4\n"})
    monkeypatch.setattr(vibedeck_server, "find_app_server", lambda: server)
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as client:
        assert client.get("/api/health").json()["vibe"]["version"] == "3.0.4"
        notes = client.get("/api/vibe/release-notes").json()
        assert notes["outdated"] is False
        assert notes["notes"][0]["version"] == "3.0.4"

        before = client.get("/api/config").json()["defaultReasoning"]
        assert client.patch("/api/config", json={"defaultReasoning": "turbo"}).status_code == 200
        assert client.patch("/api/config", json={"defaultReasoning": "Not A Level"}).status_code == 400
        client.patch("/api/config", json={"defaultReasoning": before})
