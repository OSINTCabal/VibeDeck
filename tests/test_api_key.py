"""Unit tests for API key management (mistral_api.set/remove/status/resolve).

Fully isolated: XDG_CONFIG_HOME points at a temp dir, MISTRAL_API_KEY is unset,
and the keyring lookup is monkeypatched — the user's real keyring/env are never
touched.
"""
import stat

import mistral_api
import pytest
from mistral_api import (
    DISABLED_MARKER,
    api_key_status,
    env_file_path,
    remove_api_key,
    resolve_api_key,
    set_api_key,
)

VALID_KEY = "aB3" * 12  # 36 chars, matches the accepted key shape


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """No env var, no keyring, env file under tmp_path."""
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr(mistral_api, "_keyring_key", lambda: None)
    return tmp_path


@pytest.fixture
def isolated_with_keyring(tmp_path, monkeypatch):
    """Same, but the keyring provides a key (like the user's real setup)."""
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setattr(mistral_api, "_keyring_key", lambda: "k" * 32)
    return tmp_path


def test_set_and_resolve(isolated):
    assert resolve_api_key() is None
    assert api_key_status()["present"] is False

    set_api_key(VALID_KEY)

    assert resolve_api_key() == VALID_KEY
    st = api_key_status()
    assert st["present"] is True and st["source"] == "file" and st["disabled"] is False
    # file exists with 0600 perms and no leftover tmp file
    f = env_file_path()
    assert f.exists()
    assert stat.S_IMODE(f.stat().st_mode) == 0o600
    assert not f.with_suffix(".tmp").exists()
    assert f"MISTRAL_API_KEY={VALID_KEY}" in f.read_text()


def test_set_preserves_other_lines(isolated):
    f = env_file_path()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("# vibedeck env\nOTHER_TOKEN=keepme\nexport MISTRAL_API_KEY=oldoldoldoldoldold\n")
    set_api_key(VALID_KEY)
    text = f.read_text()
    assert "OTHER_TOKEN=keepme" in text
    assert "# vibedeck env" in text
    # the old key line is replaced, not duplicated
    assert text.count("MISTRAL_API_KEY=") == 1
    assert f"MISTRAL_API_KEY={VALID_KEY}" in text
    assert resolve_api_key() == VALID_KEY


@pytest.mark.parametrize("bad", [
    "", "short", "YOUR_KEY",                       # too short / placeholder
    "has space in it 1234567890",                  # whitespace
    'quo"ted1234567890123',                        # quote
    "new\nline1234567890123",                      # newline injection
    "semi;colon1234567890123",                     # shell metachar
    "MISTRAL_API_KEY=x\nEVIL=1",                   # env-file injection attempt
])
def test_set_rejects_invalid_keys(isolated, bad):
    with pytest.raises(ValueError):
        set_api_key(bad)
    assert not env_file_path().exists() or "EVIL" not in env_file_path().read_text()
    assert resolve_api_key() is None


def test_remove_disables_even_with_keyring(isolated_with_keyring):
    # keyring provides a key (shared with the vibe CLI — must not be touched)
    assert resolve_api_key() == "k" * 32
    set_api_key(VALID_KEY)
    assert resolve_api_key() == VALID_KEY  # explicitly saved desktop key wins

    had = remove_api_key()
    assert had is True

    # explicit removal wins over the keyring
    assert resolve_api_key() is None
    st = api_key_status()
    assert st["present"] is False and st["source"] == "disabled" and st["disabled"] is True
    # the key line is gone, the marker is there
    text = env_file_path().read_text()
    assert "MISTRAL_API_KEY=" not in text
    assert f"{DISABLED_MARKER}=1" in text


def test_set_after_remove_reenables(isolated_with_keyring):
    remove_api_key()
    assert resolve_api_key() is None
    set_api_key(VALID_KEY)
    st = api_key_status()
    assert st["present"] is True and st["disabled"] is False
    assert DISABLED_MARKER not in env_file_path().read_text()
    # the saved desktop key wins over the CLI fallback
    assert resolve_api_key() == VALID_KEY


def test_env_var_wins_over_everything(isolated, monkeypatch):
    monkeypatch.setenv("MISTRAL_API_KEY", "e" * 32)
    set_api_key(VALID_KEY)
    remove_api_key()  # marker must NOT beat an explicit env var
    assert resolve_api_key() == "e" * 32
    assert api_key_status()["source"] == "env"


def test_export_prefix_parsed(isolated):
    f = env_file_path()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(f'export MISTRAL_API_KEY="{VALID_KEY}"\n')
    assert resolve_api_key() == VALID_KEY
    assert api_key_status()["source"] == "file"


def test_status_never_leaks_key(isolated):
    set_api_key(VALID_KEY)
    import json
    blob = json.dumps(api_key_status())
    assert VALID_KEY not in blob
