import pytest
from agent_routing import (
    AgentJob,
    AgentSettings,
    describe_models,
    read_settings,
    select_model,
    write_settings,
)
from pydantic import BaseModel, Field, ValidationError


class Model(BaseModel):
    alias: str
    name: str
    provider: str
    thinking: str = 'off'
    thinking_levels: list[str] = Field(default_factory=lambda: ['off','low','medium','high','max'])


@pytest.fixture
def catalog():
    return {m.alias:m for m in [Model(alias='ds-fast',name='deepseek-flash',provider='deepseek'),
                              Model(alias='ds-pro',name='deepseek-v4-pro',provider='deepseek'),
                              Model(alias='z-strong',name='glm-5.3',provider='zai'),
                              Model(alias='m-large',name='mistral-large-4',provider='mistral'),
                              Model(alias='m-coder',name='codestral',provider='mistral')]}


def test_named_provider_quality_and_effort(catalog):
    selected, _ = select_model(catalog,AgentJob(provider='deepseek',quality='strong',effort='high',task='Review'),AgentSettings())
    assert selected.alias=='ds-pro' and selected.thinking=='high'
    assert catalog['ds-pro'].thinking=='off'
    selected,_=select_model(catalog,AgentJob(provider='deepseek',quality='fast',task='Summarize'),AgentSettings())
    assert selected.alias=='ds-fast'


def test_explicit_alias_never_falls_back(catalog):
    for job in [AgentJob(model='missing',task='Review'),AgentJob(model='ds-pro',provider='zai',task='Review'),AgentJob(provider='missing',task='Review')]:
        with pytest.raises(ValueError,match='fallback'):
            select_model(catalog,job,AgentSettings())
    catalog['ds-pro'].thinking_levels=['off']
    with pytest.raises(ValueError,match='unsupported'):
        select_model(catalog,AgentJob(model='ds-pro',effort='high',task='Review'),AgentSettings())


def test_task_strengths_and_mistral_default(catalog):
    chosen,_=select_model(catalog,AgentJob(task='Review'),AgentSettings())
    assert chosen.provider=='mistral'
    chosen,_=select_model(catalog,AgentJob(task='Review',kind='coding'),AgentSettings())
    assert chosen.alias=='m-coder'
    assert describe_models(catalog)[0]['provider']=='deepseek'


def test_settings_atomic_private_and_strict(tmp_path,monkeypatch):
    monkeypatch.setenv('VIBE_HOME',str(tmp_path))
    assert read_settings().policy=='requested'
    write_settings(AgentSettings(policy='auto',quality='strong',max_workers=3))
    assert read_settings().max_workers==3
    path=tmp_path/'vibedeck/agents.json'
    assert path.stat().st_mode & 0o777==0o600
    path.write_text('invalid')
    with pytest.raises(ValueError,match='settings'):
        read_settings()
    for value in [0,4,True]:
        with pytest.raises(ValidationError):
            AgentSettings(max_workers=value)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from vibedeck_server import app
    with TestClient(app,base_url="http://127.0.0.1:9377") as test_client:
        yield test_client


def test_settings_api_and_first_boot(client):
    assert client.get('/api/agents/settings').json()['policy']=='requested'
    response=client.put('/api/agents/settings',json={'policy':'auto','quality':'strong','max_workers':2})
    assert response.status_code==200 and response.json()['quality']=='strong'
    import providers
    assert (providers.vibe_config_path().parent/'vibedeck/agent_routing.py').exists()
    assert client.put('/api/agents/settings',json={'max_workers':9}).status_code==422
    client.put('/api/agents/settings',json={'policy':'requested','quality':'balanced','max_workers':2})


def test_empty_home_bootstraps_without_extra_provider(tmp_path,monkeypatch):
    import tomllib

    from fastapi.testclient import TestClient
    from vibedeck_server import app
    monkeypatch.setenv('VIBE_HOME',str(tmp_path))
    assert not (tmp_path/'config.toml').exists()
    with TestClient(app,base_url='http://127.0.0.1:9377'):
        config=tomllib.loads((tmp_path/'config.toml').read_text())
        assert config['mcp_servers'][0]['name']=='vibedeck_providers'
        assert (tmp_path/'vibedeck/agent_routing.py').exists()


def test_minimax_is_not_misclassified_as_mini():
    model=Model(alias='minimax-m3',name='MiniMax-M3',provider='minimax')
    assert describe_models({model.alias:model})[0]['tier']=='strong'


def test_desktop_path_without_local_bin(tmp_path,monkeypatch):
    import tomllib

    import providers
    cli=tmp_path/'.local/bin/vibe'
    cli.parent.mkdir(parents=True)
    cli.write_text('#!/test/native/python\n')
    monkeypatch.setattr(providers.shutil,'which',lambda name:None)
    monkeypatch.setattr(providers.Path,'home',lambda:tmp_path)
    cfg=tmp_path/'config.toml'
    providers.sync_subagents(cfg)
    assert tomllib.loads(cfg.read_text())['mcp_servers'][0]['command']=='/test/native/python'
    plan = tmp_path/'agents/plan.toml'
    assert tomllib.loads(plan.read_text())['enabled_tools'] == ['read_file', 'grep']
    assert plan.stat().st_mode & 0o777 == 0o600
    plan.write_text('display_name = "My Plan"\n')
    providers.sync_subagents(cfg)
    assert plan.read_text() == 'display_name = "My Plan"\n'


@pytest.mark.asyncio
async def test_policy_reaches_models_and_refreshes_idle_sessions(tmp_path,monkeypatch):
    import vibedeck_server as server
    from fake_bridge import FakeBridge
    monkeypatch.setenv('VIBE_HOME',str(tmp_path))
    bridge=FakeBridge(str(tmp_path))
    await bridge.start_session()
    sid=bridge.session_id
    server.manager.register(sid,bridge)
    server.store.upsert_session(sid,title='Policy fixture',cwd=str(tmp_path),model='mistral-large-4',agent='ask',status='running')
    try:
        await server.put_agent_settings(AgentSettings(policy='auto',quality='strong'))
        still,_=await server._ensure_bridge(sid)
        assert still is bridge and bridge.alive,'Policy change interrupted a running turn'
        server.store.set_session_status(sid,'idle')
        newer,_=await server._ensure_bridge(sid)
        assert newer is not bridge and not bridge.alive
        resume=next(params for method,params in newer.calls if method=='session/resume')
        assert resume['sessionId']==sid
        instructions=(tmp_path/'AGENTS.md').read_text()
        assert 'Proactively delegate' in instructions and 'strong' in instructions
    finally:
        await server._stop_tap(sid)
        await server.manager.close(sid)
        server._stale_agent_policy.clear()
        server.store.delete_session(sid)


def test_managed_instructions_preserve_user_text(tmp_path,monkeypatch):
    monkeypatch.setenv('VIBE_HOME',str(tmp_path))
    instructions=tmp_path/'AGENTS.md'
    original='# My Vibe preferences\nKeep my instructions.\n'
    instructions.write_text(original)
    instructions.chmod(0o640)
    write_settings(AgentSettings(policy='auto'))
    assert instructions.read_text().startswith(original)
    with instructions.open('a') as stream:
        stream.write('\nUser footer remains.\n')
    write_settings(AgentSettings(policy='off'))
    text=instructions.read_text()
    assert text.startswith(original) and text.endswith('\nUser footer remains.\n')
    assert text.count('<!-- VibeDeck subagents:start -->')==1
    assert 'Do not delegate; subagents are disabled' in text
    assert instructions.stat().st_mode & 0o777==0o640


def test_instructions_conflicts_do_not_overwrite_user_files(tmp_path,monkeypatch):
    monkeypatch.setenv('VIBE_HOME',str(tmp_path))
    doc=tmp_path/'AGENTS.md'
    doc.write_text('My instructions\n<!-- VibeDeck subagents:start -->')
    with pytest.raises(ValueError,match='malformed'):
        write_settings(AgentSettings(policy='auto'))
    assert not (tmp_path/'vibedeck/agents.json').exists()
    doc.unlink()
    independent=tmp_path/'shared.md'
    independent.write_text('Independent instructions')
    doc.symlink_to(independent)
    with pytest.raises(ValueError,match='symlink'):
        write_settings(AgentSettings(policy='auto'))
    assert doc.is_symlink() and independent.read_text()=='Independent instructions'
