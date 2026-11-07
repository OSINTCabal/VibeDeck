"""Tests for multi-provider management: config.toml editing, keyring, API."""
import tomllib

import providers
import pytest
import vibedeck_server
from fastapi.testclient import TestClient


def test_locked_keyring_delete_does_not_remove_provider(client, cfg, fake_keyring, monkeypatch):
    providers.upsert_provider({"name": "local", "api_base": "http://localhost:11434/v1",
                              "api_key_env_var": "TEST_API_KEY"}, cfg)
    original = cfg.read_text()
    def locked(*args):
        raise RuntimeError("private-keyring-detail")
    monkeypatch.setattr(providers, "_keyring_delete", locked)
    for path in ("/api/providers/local/key", "/api/providers/local"):
        result = client.delete(path)
        assert result.status_code == 503
        assert "private-keyring-detail" not in result.text
        assert cfg.read_text() == original


def test_keyring_delete_distinguishes_missing_from_failed(monkeypatch):
    import keyring
    from keyring.errors import PasswordDeleteError
    def failed(*args):
        raise PasswordDeleteError("backend unavailable")
    monkeypatch.setattr(keyring, "delete_password", failed)
    providers._keyring_delete("fixture", "missing")
    monkeypatch.setattr(providers, "_keyring_get", lambda *args: "fixture-secret")
    with pytest.raises(PasswordDeleteError):
        providers._keyring_delete("fixture", "present")


def test_locked_keyring_read_does_not_change_config(client, cfg, fake_keyring, monkeypatch):
    original = cfg.read_text()
    def locked(*args):
        raise RuntimeError("private-keyring-detail")
    monkeypatch.setattr(providers, "_keyring_get", locked)
    result = client.put("/api/providers", json={"name": "local", "api_base": "http://localhost:11434/v1",
                                               "api_key_env_var": "TEST_API_KEY", "key": "fixture-secret"})
    assert result.status_code == 503
    assert "private-keyring-detail" not in result.text
    assert cfg.read_text() == original


@pytest.fixture()
def cfg(tmp_path, monkeypatch):
    """Isolated vibe config: VIBE_HOME points at a temp dir."""
    home = tmp_path / "vibe-home"
    home.mkdir()
    (home / "config.toml").write_text(
        '# user config\nactive_model = "mistral-large-4"\n\n'
        '[[providers]]\nname = "ollama"\napi_base = "http://127.0.0.1:11435/v1"\n'
        'api_style = "openai"\nbackend = "generic"\n\n'
        '[[models]]\nname = "devstral-vibe32-gpu8"\nprovider = "ollama"\n'
        'alias = "devstral-ollama"\ntemperature = 0.15\n\n'
        '[[models]]\nname = "mistral-large-4"\nprovider = "mistral"\n'
        'alias = "mistral-large-4"\nthinking = "max"\n'
    )
    monkeypatch.setenv("VIBE_HOME", str(home))
    return home / "config.toml"


@pytest.fixture()
def fake_keyring(monkeypatch):
    """In-memory keyring standing in for the system keyring."""
    store: dict[tuple[str, str], str] = {}
    monkeypatch.setattr(providers, "_keyring_set",
                        lambda s, u, p: store.__setitem__((s, u), p))
    monkeypatch.setattr(providers, "_keyring_get",
                        lambda s, u: store.get((s, u)))
    monkeypatch.setattr(providers, "_keyring_delete",
                        lambda s, u: store.pop((s, u), None))
    return store


# ---------------------------------------------------------------- TOML editing

def test_read_existing(cfg):
    provs = providers.read_providers(cfg)
    assert [p["name"] for p in provs] == ["ollama"]
    assert provs[0]["api_base"] == "http://127.0.0.1:11435/v1"
    models = providers.read_models(cfg)
    assert {m["alias"] for m in models} == {"devstral-ollama", "mistral-large-4"}
    big = next(m for m in models if m["alias"] == "mistral-large-4")
    assert big["thinking"] == "max" and big["provider"] == "mistral"


def test_upsert_provider_adds_and_replaces(cfg):
    providers.upsert_provider({"name": "openai", "api_base": "https://api.openai.com/v1",
                               "api_style": "openai", "backend": "generic",
                               "api_key_env_var": "OPENAI_API_KEY"}, cfg)
    providers.upsert_provider({"name": "openai", "api_base": "https://api.openai.com/v1",
                               "api_style": "openai", "backend": "generic",
                               "api_key_env_var": "OPENAI_API_KEY"}, cfg)
    provs = providers.read_providers(cfg)
    assert [p["name"] for p in provs] == ["ollama", "openai"]  # no duplicate
    # valid TOML, comments preserved
    text = cfg.read_text()
    assert text.startswith("# user config")
    data = tomllib.loads(text)
    assert [p["name"] for p in data["providers"]] == ["ollama", "openai"]
    assert data["active_model"] == "mistral-large-4"


def test_native_cli_inline_arrays_remain_editable(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text('# Native CLI formatting\nactive_model = "local"\n'
                    'providers = [{name = "local", api_base = "http://localhost:11434/v1", headers = {custom = "keep"}}]\n'
                    'models = [{name = "local", alias = "local", provider = "local", unknown = {keep = true}}]\n'
                    'mcp_servers = []\n')
    providers.upsert_provider({"name": "other", "api_base": "http://localhost:11435/v1"}, path)
    providers.upsert_model({"name": "other", "alias": "other", "provider": "other"}, path)
    providers.upsert_model({"name": "updated", "alias": "local", "provider": "local"}, path)
    providers.sync_subagents(path)
    data = tomllib.loads(path.read_text())
    assert data["providers"][0]["headers"] == {"custom": "keep"}
    assert data["models"][0]["unknown"] == {"keep": True}
    assert data["models"][0]["name"] == "updated"
    assert data["mcp_servers"][0]["name"] == "vibedeck_providers"
    assert providers.remove_provider("other", path)
    assert len(tomllib.loads(path.read_text())["models"]) == 1
    assert path.read_text().startswith("# Native CLI formatting")


def test_upsert_model_and_remove_cascade(cfg):
    providers.upsert_model({"name": "gpt-5.1", "provider": "ollama",
                            "alias": "gpt-5.1", "temperature": 0.2}, cfg)
    providers.upsert_model({"name": "gpt-5.1", "provider": "ollama",
                            "alias": "gpt-5.1", "temperature": 0.9}, cfg)
    models = providers.read_models(cfg)
    assert len([m for m in models if m["alias"] == "gpt-5.1"]) == 1
    assert next(m for m in models if m["alias"] == "gpt-5.1")["temperature"] == 0.9
    tomllib.loads(cfg.read_text())  # still valid

    assert providers.remove_provider("ollama", cfg) is True
    assert providers.read_providers(cfg) == []
    # the provider's models cascade away; other providers' models stay
    assert all(m["provider"] != "ollama" for m in providers.read_models(cfg))
    assert {m["alias"] for m in providers.read_models(cfg)} == {"mistral-large-4"}
    assert providers.remove_provider("ollama", cfg) is False  # idempotent


def test_remove_model_by_alias(cfg):
    assert providers.remove_model("devstral-ollama", cfg) is True
    assert {m["alias"] for m in providers.read_models(cfg)} == {"mistral-large-4"}
    assert providers.remove_model("devstral-ollama", cfg) is False


def test_roundtrip_preserves_unrelated_content(cfg):
    original = cfg.read_text()
    providers.upsert_provider({"name": "openai", "api_base": "https://api.openai.com/v1"}, cfg)
    providers.remove_provider("openai", cfg)
    assert cfg.read_text() == original


# ---------------------------------------------------------------- validation

def test_validate_provider_rejects():
    with pytest.raises(ValueError):
        providers.validate_provider({"name": "Mistral", "api_base": "https://x.com"})
    with pytest.raises(ValueError):
        providers.validate_provider({"name": "mistral", "api_base": "https://x.com"})
    with pytest.raises(ValueError):
        providers.validate_provider({"name": "openai", "api_base": "ftp://x"})
    with pytest.raises(ValueError):
        providers.validate_provider({"name": "openai", "api_base": "https://x.com",
                                     "api_key_env_var": "lowercase"})
    with pytest.raises(ValueError):
        providers.validate_provider({"name": "openai", "api_base": "https://x.com",
                                     "backend": "bogus"})
    ok = providers.validate_provider({"name": "openai", "api_base": "https://x.com"})
    assert ok["api_style"] == "openai" and ok["backend"] == "generic"


def test_validate_model_rejects():
    known = {"mistral", "ollama"}
    with pytest.raises(ValueError):
        providers.validate_model({"name": "x", "provider": "nope", "alias": "x"}, known)
    with pytest.raises(ValueError):
        providers.validate_model({"name": "x", "provider": "ollama", "alias": "Bad Alias"}, known)
    with pytest.raises(ValueError):
        providers.validate_model({"name": "x", "provider": "ollama", "alias": "x",
                                  "temperature": 3.0}, known)
    with pytest.raises(ValueError):
        providers.validate_model({"name": "x", "provider": "ollama", "alias": "x",
                                  "thinking": "ultra"}, known)
    ok = providers.validate_model({"name": "x", "provider": "ollama", "alias": "x",
                                   "supports_images": True}, known)
    assert ok["supports_images"] is True


def test_validate_key_rejects():
    with pytest.raises(ValueError):
        providers.validate_key("short")
    with pytest.raises(ValueError):
        providers.validate_key("has space in it")
    assert providers.validate_key("fixture-key-one") == "fixture-key-one"


# ---------------------------------------------------------------- keyring

def test_keyring_set_status_delete(fake_keyring, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert providers.provider_key_status("OPENAI_API_KEY") == {"present": False, "source": None}
    providers.set_provider_key("OPENAI_API_KEY", "fixture-key-one")
    assert providers.provider_key_status("OPENAI_API_KEY") == {"present": True, "source": "keyring"}
    # env var wins over keyring (mirrors the vibe CLI's resolution order)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env")
    assert providers.provider_key_status("OPENAI_API_KEY") == {"present": True, "source": "env"}
    monkeypatch.delenv("OPENAI_API_KEY")
    providers.delete_provider_key("OPENAI_API_KEY")
    assert providers.provider_key_status("OPENAI_API_KEY") == {"present": False, "source": None}


def test_list_providers_view(cfg, fake_keyring, monkeypatch):
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    view = providers.list_providers(cfg)
    assert view["configPath"] == str(cfg)
    names = [p["name"] for p in view["providers"]]
    assert "ollama" in names and "mistral" in names
    builtin = next(p for p in view["providers"] if p["name"] == "mistral")
    assert builtin["builtin"] is True
    assert {m["alias"] for m in builtin["models"]} == {"mistral-large-4"}
    ollama = next(p for p in view["providers"] if p["name"] == "ollama")
    assert ollama["key"] == {"present": False, "source": None}


# ---------------------------------------------------------------- API endpoints

@pytest.fixture(scope="module")
def client():
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as c:
        yield c


def test_api_providers_crud(client, cfg, fake_keyring, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    r = client.get("/api/providers")
    assert r.status_code == 200
    assert any(p["name"] == "ollama" for p in r.json()["providers"])

    # add a provider with a key and two models
    r = client.put("/api/providers", json={
        "name": "openai",
        "api_base": "https://api.openai.com/v1",
        "api_style": "openai",
        "backend": "generic",
        "api_key_env_var": "OPENAI_API_KEY",
        "key": "fixture-key-one",
        "models": [
            {"name": "gpt-5.1", "provider": "openai", "alias": "gpt-5.1",
             "temperature": 0.2, "input_price": 1.25, "output_price": 10.0},
            {"name": "gpt-5.1-mini", "provider": "openai", "alias": "gpt-5.1-mini"},
        ],
    })
    assert r.status_code == 200, r.text
    body = r.text
    assert "fixture-key-one" not in body  # the key is never echoed
    prov = next(p for p in r.json()["providers"] if p["name"] == "openai")
    assert prov["key"] == {"present": True, "source": "keyring"}
    assert {m["alias"] for m in prov["models"]} == {"gpt-5.1", "gpt-5.1-mini"}

    # the config file on disk is valid TOML with the new tables
    data = tomllib.loads(cfg.read_text())
    assert "openai" in [p["name"] for p in data["providers"]]

    # key status endpoint: status only
    r = client.get("/api/providers/openai/key")
    assert r.status_code == 200
    assert r.json()["key"] == {"present": True, "source": "keyring"}
    assert "fixture-key-one" not in r.text

    # replace the key
    r = client.put("/api/providers/openai/key", json={"key": "fixture-key-two"})
    assert r.status_code == 200
    assert r.json()["key"]["present"] is True
    assert fake_keyring[("ai.mistral.vibe", "OPENAI_API_KEY")] == "fixture-key-two"

    # remove the key
    r = client.delete("/api/providers/openai/key")
    assert r.status_code == 200
    assert r.json()["key"] == {"present": False, "source": None}

    # upsert a single model
    r = client.put("/api/providers/openai/models", json={
        "name": "gpt-5.2", "alias": "gpt-5.2", "thinking": "off"})
    assert r.status_code == 200
    prov = next(p for p in r.json()["providers"] if p["name"] == "openai")
    assert "gpt-5.2" in {m["alias"] for m in prov["models"]}

    # delete that model
    r = client.delete("/api/providers/openai/models/gpt-5.2")
    assert r.status_code == 200
    prov = next(p for p in r.json()["providers"] if p["name"] == "openai")
    assert "gpt-5.2" not in {m["alias"] for m in prov["models"]}

    # delete the provider: models cascade, key removed
    client.put("/api/providers/openai/key", json={"key": "fixture-key-two"})
    r = client.delete("/api/providers/openai")
    assert r.status_code == 200
    assert "openai" not in [p["name"] for p in r.json()["providers"]]
    assert ("ai.mistral.vibe", "OPENAI_API_KEY") not in fake_keyring
    data = tomllib.loads(cfg.read_text())
    assert "openai" not in [p["name"] for p in data["providers"]]
    assert all(m.get("provider") != "openai" for m in data["models"])


def test_api_providers_validation_errors(client, cfg, fake_keyring):
    r = client.put("/api/providers", json={"name": "mistral", "api_base": "https://x.com"})
    assert r.status_code == 400
    r = client.put("/api/providers", json={"name": "openai", "api_base": "nope"})
    assert r.status_code == 400
    r = client.put("/api/providers", json={
        "name": "openai", "api_base": "https://api.openai.com/v1",
        "api_key_env_var": "OPENAI_API_KEY", "key": "bad key with spaces"})
    assert r.status_code == 400
    r = client.put("/api/providers", json={
        "name": "openai", "api_base": "https://api.openai.com/v1",
        "models": [{"name": "x", "provider": "ghost", "alias": "x"}]})
    assert r.status_code == 400
    r = client.delete("/api/providers/ghost")
    assert r.status_code == 404
    r = client.delete("/api/providers/mistral")
    assert r.status_code == 400  # built-in is protected
    r = client.get("/api/providers/ghost/key")
    assert r.status_code == 404


def test_api_provider_change_invalidates_model_cache(client, cfg, fake_keyring):
    client.get("/api/config")  # populate the cache
    assert vibedeck_server._vibe_models_cache is not None
    r = client.put("/api/providers", json={
        "name": "anthropic", "api_base": "https://api.anthropic.com/v1",
        "api_key_env_var": "ANTHROPIC_API_KEY",
        "models": [{"name": "claude-sonnet-4-5", "provider": "anthropic",
                    "alias": "claude"}]})
    assert r.status_code == 200
    assert vibedeck_server._vibe_models_cache is None  # invalidated
    # and the new model shows up in the registry on the next read
    r = client.get("/api/config")
    aliases = [m["id"] for m in r.json()["vibeModels"]]
    assert "claude" in aliases
    client.delete("/api/providers/anthropic")


def test_api_agents_lists_subagents(client):
    r = client.get("/api/agents")
    assert r.status_code == 200
    agents = r.json()["agents"]
    names = {a["name"] for a in agents}
    # built-in modes + the user's fleet subagents are all visible
    assert {"ask", "accept-edits", "codex", "agy"} <= names
    codex = next(a for a in agents if a["name"] == "codex")
    assert codex["agentType"] == "subagent"
    assert codex["displayName"] == "Codex"
    assert codex["path"] and codex["path"].endswith("codex.toml")


def test_api_config_rejects_subagent_as_primary_mode(client):
    r = client.patch("/api/config", json={"defaultAgent": "codex"})
    assert r.status_code == 400, r.text
    # restore
    r = client.patch("/api/config", json={"defaultAgent": "accept-edits"})
    assert r.status_code == 200
    # unknown agents still rejected with the available list
    r = client.patch("/api/config", json={"defaultAgent": "bogus-agent"})
    assert r.status_code == 400
    assert "ask" in r.json()["detail"]


def test_provider_presets_and_native_worker_lifecycle(cfg):
    view = providers.list_providers(cfg)
    assert view["providers"][0]["name"] == "mistral"
    assert view["providers"][0]["builtin"]
    assert {p["name"] for p in view["presets"]} >= {"openai", "claude", "deepseek", "zai", "minimax", "google", "ollama"}
    providers.sync_subagents(cfg)
    tool = cfg.parent / "vibedeck/provider_task.py"
    assert tool.read_text().startswith("# Managed by VibeDeck: provider routing tool")
    assert "create_backend" in tool.read_text()
    assert {a["model"] for a in providers.list_providers(cfg)["subagents"]} >= {"devstral-ollama", "mistral-large-4"}
    providers.remove_provider("ollama", cfg)
    providers.sync_subagents(cfg)
    assert "devstral-ollama" not in {a["model"] for a in providers.list_providers(cfg)["subagents"]}
    tool.write_text("# independently authored custom tool\n")
    with pytest.raises(ValueError, match="independent"):
        providers.sync_subagents(cfg)
    assert tool.read_text() == "# independently authored custom tool\n"


def test_unchanged_worker_sync_preserves_config_and_file_identity(cfg):
    providers.sync_subagents(cfg)
    files = [cfg, cfg.parent / "AGENTS.md", cfg.parent / "vibedeck/provider_task.py",
             cfg.parent / "vibedeck/agent_routing.py"]
    before = {p: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in files}
    providers.sync_subagents(cfg)
    assert {p: (p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns) for p in files} == before


def test_unchanged_config_save_still_detects_external_edit(cfg):
    original, document = providers._document(cfg)
    assert providers.tomlkit.dumps(document) == original
    cfg.write_text(original + "\n# Edited in the CLI\n")
    with pytest.raises(ValueError, match="changed externally"):
        providers._write_document(cfg, original, document)
    assert cfg.read_text().endswith("# Edited in the CLI\n")


def test_empty_config_write_creates_file(tmp_path):
    path = tmp_path / "new-home/config.toml"
    original, document = providers._document(path)
    providers._write_document(path, original, document)
    assert path.is_file() and path.read_text() == ""
    assert path.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize("base", ["https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "http://example.com/v1", "https://example.com:bad/v1"])
def test_provider_urls_do_not_leak_keys(base):
    with pytest.raises(ValueError):
        providers.validate_provider({"name": "test", "api_base": base})


def test_responses_style_and_file_credential(cfg):
    assert providers.validate_provider({"name": "openai", "api_base": "https://api.openai.com/v1/", "api_style": "openai-responses"})["api_base"] == "https://api.openai.com/v1"
    (cfg.parent / ".env").write_text("DEEPSEEK_API_KEY=local-fixture-key\n")
    assert providers.provider_key_status("DEEPSEEK_API_KEY") == {"present": True, "source": "file"}
    assert providers.provider_key("DEEPSEEK_API_KEY") == "local-fixture-key"


def test_config_write_failure_restores_provider_key(client, cfg, fake_keyring, monkeypatch):
    fake_keyring[("ai.mistral.vibe", "OPENAI_API_KEY")] = "original-key"
    original = cfg.read_text()
    def fail(*args):
        raise ValueError("configuration changed externally")
    monkeypatch.setattr(vibedeck_server, "apply_provider_edit", fail)
    result = client.put("/api/providers", json={"name": "openai", "api_base": "https://api.openai.com/v1",
        "api_key_env_var": "OPENAI_API_KEY", "key": "replacement-key"})
    assert result.status_code == 409
    assert fake_keyring[("ai.mistral.vibe", "OPENAI_API_KEY")] == "original-key"
    assert cfg.read_text() == original


def test_removing_default_provider_restores_mistral_and_keeps_shared_key(client, cfg, fake_keyring):
    for name in ('one', 'two'):
        response = client.put('/api/providers', json={'name': name, 'api_base': 'https://example.com/v1',
            'api_key_env_var': 'SHARED_API_KEY', 'models': [{'name': name, 'alias': name}]})
        assert response.status_code == 200
    fake_keyring[('ai.mistral.vibe', 'SHARED_API_KEY')] = 'shared-secret'
    vibedeck_server.store.set_config('default_model', 'one')
    assert client.delete('/api/providers/one').status_code == 200
    assert fake_keyring[('ai.mistral.vibe', 'SHARED_API_KEY')] == 'shared-secret'
    assert vibedeck_server.store.get_config('default_model') == 'mistral-large-4'


def test_keyring_failure_does_not_change_config(client, cfg, monkeypatch):
    original = cfg.read_text()
    def locked(*args):
        raise RuntimeError('private keyring detail')
    monkeypatch.setattr(providers, '_keyring_set', locked)
    response = client.put('/api/providers', json={'name': 'new', 'api_base': 'https://example.com/v1',
        'api_key_env_var': 'NEW_API_KEY', 'key': 'new-test-secret'})
    assert response.status_code == 503 and 'private' not in response.text
    assert cfg.read_text() == original


@pytest.mark.parametrize('name,style,expected', [('example', 'openai', '/v1/models'), ('example', 'anthropic', '/v1/models')])
def test_catalog_is_read_only_and_does_not_expose_errors(client, cfg, fake_keyring, monkeypatch, name, style, expected):
    import httpx
    client.put('/api/providers', json={'name': name, 'api_base': 'https://example.com' if style == 'anthropic' else 'https://example.com/v1',
        'api_style': style, 'api_key_env_var': 'TEST_API_KEY'})
    assert client.get(f'/api/providers/{name}/catalog').status_code == 400
    fake_keyring[('ai.mistral.vibe', 'TEST_API_KEY')] = 'private-test-key'
    async def get(self, url, **kwargs):
        assert url.endswith(expected)
        headers = kwargs['headers']
        assert headers.get('x-api-key' if style == 'anthropic' else 'Authorization')
        return httpx.Response(200, json={'data': [{'id': 'test-model'}]})
    monkeypatch.setattr(httpx.AsyncClient, 'get', get)
    response = client.get(f'/api/providers/{name}/catalog')
    assert response.status_code == 200 and response.json()['models'][0]['id'] == 'test-model'
    assert 'private-test-key' not in response.text


def test_shared_skills_setting_uses_cli_config(client, cfg):
    original = cfg.read_text()
    assert client.get("/api/skills").json()["sharedEnabled"] is False
    assert client.put("/api/skills/shared", json={"enabled": True}).status_code == 200
    assert tomllib.loads(cfg.read_text())["experimental_enable_registry_skills"] is True
    assert "# user config" in cfg.read_text()
    assert tomllib.loads(cfg.read_text())["providers"] == tomllib.loads(original)["providers"]
    assert client.get("/api/skills").json()["sharedEnabled"] is True
    assert client.put("/api/skills/shared", json={"enabled": "true"}).status_code == 422
    assert client.put("/api/skills/shared", json={"enabled": False}).status_code == 200
    cfg.write_text("invalid TOML [")
    assert client.put("/api/skills/shared", json={"enabled": True}).status_code == 400
    assert cfg.read_text() == "invalid TOML ["
