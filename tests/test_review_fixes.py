import json
import os
import stat
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import mistral_api
import pytest
import vibedeck_server as server
from agent_routing import AgentSettings, read_settings
from fastapi.testclient import TestClient
from store import Store
from vibe_bridge import BridgeError, VibeAppServer
from vibe_sessions import VibeSessionSync


def test_credentials_private_before_first_write(tmp_path, monkeypatch):
    target = tmp_path / 'vibedeck/env'
    fdopen = os.fdopen
    checked = []

    def inspect(fd, *args, **kwargs):
        assert stat.S_IMODE(os.fstat(fd).st_mode) == 0o600
        assert stat.S_IMODE(target.parent.stat().st_mode) == 0o700
        checked.append(True)
        return fdopen(fd, *args, **kwargs)

    monkeypatch.setattr(mistral_api.os, 'fdopen', inspect)
    mask = os.umask(0o022)
    try:
        mistral_api._update_env_file(target, {'MISTRAL_API_KEY': 'private-test-value'})
    finally:
        os.umask(mask)
    assert checked and target.read_text() == 'MISTRAL_API_KEY=private-test-value\n'
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_credentials_failed_replace_preserves_previous_file(tmp_path, monkeypatch):
    target = tmp_path / 'vibedeck/env'
    target.parent.mkdir()
    target.write_text('# Existing settings\nOTHER=keep\n')
    trap = target.with_suffix('.tmp')
    trap.write_text('Independent file')

    def fail(*args):
        raise OSError('Fixture replace failure')

    monkeypatch.setattr(mistral_api.os, 'replace', fail)
    with pytest.raises(OSError):
        mistral_api._update_env_file(target, {'MISTRAL_API_KEY': 'private-test-value'})
    assert target.read_text() == '# Existing settings\nOTHER=keep\n'
    assert trap.read_text() == 'Independent file'
    assert not list(target.parent.glob('.env-*'))


@pytest.mark.asyncio
async def test_stream_preserves_literal_terminator_and_usage(monkeypatch):
    class Response:
        status_code = 200

        async def aiter_lines(self):
            for line in [
                'data: ' + json.dumps({'choices': [{'delta': {'content': 'literal [DONE] output'}}]}),
                'data:' + json.dumps({'choices': [], 'usage': {'prompt_tokens': 7}}),
                'data: [DONE]',
                'data: ' + json.dumps({'choices': [{'delta': {'content': 'after terminator'}}]}),
            ]:
                yield line

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        @asynccontextmanager
        async def stream(self, *args, **kwargs):
            yield Response()

    monkeypatch.setattr(mistral_api.httpx, 'AsyncClient', Client)
    usage = []
    result = [chunk async for chunk in mistral_api.chat_stream('fixture', 'model', [], on_usage=usage.append)]
    assert json.loads(result[0][6:]) == {'stream': 'text', 'delta': 'literal [DONE] output'}
    assert result[1:] == ['data: [DONE]\n\n']
    assert usage == [{'prompt_tokens': 7}]


@pytest.mark.asyncio
@pytest.mark.parametrize('listed', [[], [{'id': 'kept'}]])
async def test_deleted_cli_rows_reconcile_without_losing_usage(tmp_path, monkeypatch, listed):
    store = Store(tmp_path / 'registry.db')
    sync = VibeSessionSync(store, server.manager)
    for sid in ['deleted', 'kept', 'live', 'legacy', 'native-live']:
        store.upsert_session(sid, origin='vibe', vibe_session_id={'legacy': 'unified', 'native-live': 'live-native'}.get(sid))
    store.upsert_session('desktop', origin='vibedeck')
    store.upsert_costs('deleted', {})
    store.upsert_costs('deleted', {'sessionPromptTokens': 7}, event_key='fixture')
    bridge = type('Lister', (), {'list_sessions': AsyncMock(return_value=listed + [{'id': 'unified'}])})()
    monkeypatch.setattr(sync, '_lister', AsyncMock(return_value=bridge))
    await sync.sync(live_sids={'live', 'live-native'}, force=True)
    assert store.get_session('deleted') is None
    assert (store.get_session('kept') is not None) == bool(listed)
    assert all(store.get_session(sid) for sid in ['desktop', 'live', 'legacy', 'native-live'])
    con = store._con()
    assert con.execute('SELECT prompt_tokens FROM costs WHERE session_id=?', ('deleted',)).fetchone()[0] == 7
    assert con.execute('SELECT COUNT(*) FROM usage_events WHERE session_id=?', ('deleted',)).fetchone()[0] == 1
    con.close()


@pytest.mark.asyncio
async def test_successful_empty_listing_prunes_but_cached_or_failed_listing_never_does(tmp_path, monkeypatch):
    store = Store(tmp_path / 'registry.db')
    sync = VibeSessionSync(store, server.manager)
    bridge = type('Lister', (), {'list_sessions': AsyncMock(return_value=[])})()
    monkeypatch.setattr(sync, '_lister', AsyncMock(return_value=bridge))
    store.upsert_session('old', origin='vibe')
    await sync.sync(force=True)
    assert store.get_session('old') is None
    store.upsert_session('new', origin='vibe')
    await sync.sync()
    assert store.get_session('new')
    bridge.list_sessions.side_effect = BridgeError('failed', 'Fixture listing failed')
    await sync.sync(force=True)
    assert store.get_session('new')
    bridge.list_sessions.side_effect = None
    bridge.list_sessions.return_value = [{'title': 'Missing ID'}]
    await sync.sync(force=True)
    assert store.get_session('new')


@pytest.mark.asyncio
@pytest.mark.parametrize('pages', [
    [{'items': [], 'nextCursor': 'repeat'}, {'items': [], 'nextCursor': 'repeat'}],
    [{}], [{'items': [{'title': 'No ID'}]}], [{'items': [], 'nextCursor': 7}], [{'items': [], 'nextCursor': 0}],
])
async def test_incomplete_pagination_is_not_authoritative(monkeypatch, pages):
    bridge = VibeAppServer('/tmp', server_cmd='fixture')
    monkeypatch.setattr(bridge, 'call', AsyncMock(side_effect=pages))
    with pytest.raises(BridgeError, match='listing'):
        await bridge.list_sessions()


def test_valid_policy_repairs_malformed_json_without_changing_user_instructions(tmp_path, monkeypatch):
    monkeypatch.setenv('VIBE_HOME', str(tmp_path))
    (tmp_path / 'vibedeck').mkdir()
    (tmp_path / 'vibedeck/agents.json').write_text('{broken')
    (tmp_path / 'AGENTS.md').write_text('My existing instructions\n')
    with TestClient(server.app, base_url='http://127.0.0.1:9377') as client:
        result = client.get('/api/agents/settings')
        assert result.status_code == 409 and result.json()['code'] == 'invalid_agent_settings'
        assert client.put('/api/agents/settings', json={'policy': 'off', 'quality': 'balanced', 'max_workers': 2}).status_code == 200
        assert client.get('/api/agents/settings').json()['policy'] == 'off'
    assert read_settings() == AgentSettings(policy='off')
    assert (tmp_path / 'AGENTS.md').read_text().startswith('My existing instructions\n')


def test_policy_read_permission_failure_does_not_offer_replacement_defaults(monkeypatch):
    def denied():
        raise ValueError('Could not read settings') from PermissionError('Fixture permission failure')

    monkeypatch.setattr(server, 'read_agent_settings', denied)
    with TestClient(server.app, base_url='http://127.0.0.1:9377') as client:
        result = client.get('/api/agents/settings')
        assert result.status_code == 409 and 'code' not in result.json()


@pytest.mark.asyncio
async def test_failed_second_page_preserves_previously_imported_rows(tmp_path, monkeypatch):
    store = Store(tmp_path / 'registry.db')
    store.upsert_session('existing', origin='vibe')
    sync = VibeSessionSync(store, server.manager)
    bridge = VibeAppServer('/tmp', server_cmd='fixture')
    monkeypatch.setattr(bridge, 'call', AsyncMock(side_effect=[
        {'items': [{'id': 'new'}], 'nextCursor': 'page-two'}, BridgeError('failed', 'Fixture page failure')]))
    monkeypatch.setattr(sync, '_lister', AsyncMock(return_value=bridge))
    await sync.sync(force=True)
    assert store.get_session('existing') and not store.get_session('new')
