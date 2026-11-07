import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import codex_provider
import pytest
from vibe_bridge import BridgeError


@pytest.mark.asyncio
@pytest.mark.parametrize(('effort', 'supported', 'expected'), [
    ('high', ['low', 'high'], 'high'), ('off', ['none', 'high'], 'none'),
    ('max', ['low', 'xhigh'], 'xhigh'), ('max', ['max', 'xhigh'], 'max'),
    (None, [], None), ('auto', [], None),
])
async def test_effort_reaches_native_turn(monkeypatch, effort, supported, expected):
    class Client:
        def __init__(self, cwd):
            self.closed = False
            self.start = AsyncMock()
            self.call = AsyncMock(side_effect=self.answer)

        async def answer(self, method, params):
            if method == 'model/list':
                if not params:
                    return {'data': [], 'nextCursor': 'next'}
                return {'data': [{'id': 'test', 'supportedReasoningEfforts': [{'reasoningEffort': level} for level in supported]}]}
            if method == 'thread/start':
                return {'thread': {'id': 'thread'}}
            return {}

        def subscribe(self, **kwargs):
            return asyncio.Queue()

        async def close(self):
            self.closed = True

    monkeypatch.setattr(codex_provider, 'CodexClient', Client)
    provider = codex_provider.CodexProvider()
    body = {'model': 'test', 'messages': [{'role': 'user', 'content': 'hello'}]}
    if effort is not None:
        body['reasoning_effort'] = effort
    value = await provider.new_context(body)
    calls = value['client'].call.call_args_list
    turn = next(call.args[1] for call in calls if call.args[0] == 'turn/start')
    assert turn.get('effort') == expected
    assert ('effort' in turn) == (expected is not None)
    if expected is None:
        assert not any(call.args[0] == 'model/list' for call in calls)
    await provider.close()
    assert value['client'].closed and not provider.contexts


@pytest.mark.asyncio
@pytest.mark.parametrize('effort', ['high', 'max', 'invented', 7])
async def test_unsupported_effort_never_starts_native_thread(monkeypatch, effort):
    client = SimpleNamespace(start=AsyncMock(), close=AsyncMock(),
        call=AsyncMock(return_value={'data': [{'id': 'test', 'supportedReasoningEfforts': [{'reasoningEffort': 'low'}]}]}))
    monkeypatch.setattr(codex_provider, 'CodexClient', lambda cwd: client)
    provider = codex_provider.CodexProvider()
    with pytest.raises(BridgeError, match='reasoning effort'):
        await provider.new_context({'model': 'test', 'messages': [], 'reasoning_effort': effort})
    assert not any(call.args[0] in ('thread/start', 'turn/start') for call in client.call.call_args_list)
    assert not provider.contexts


@pytest.mark.asyncio
@pytest.mark.parametrize('catalog', [{}, {'data': None}, {'data': ['bad']},
                                  {'data': [{'id': 'test', 'supportedReasoningEfforts': None}]}])
async def test_missing_effort_metadata_fails_without_model_call(catalog):
    provider = codex_provider.CodexProvider()
    client = SimpleNamespace(call=AsyncMock(return_value=catalog))
    with pytest.raises(BridgeError, match='reasoning effort'):
        await provider.resolve_effort(client, 'test', 'high')
    assert all(call.args[0] == 'model/list' for call in client.call.call_args_list)


class FakeClient:
    def __init__(self):
        self.closed = False
        self.sent = []

    async def close(self):
        self.closed = True

    def _send_raw(self, message):
        self.sent.append(message)


def context(provider, events, model='test'):
    queue = asyncio.Queue()
    for event in events:
        queue.put_nowait(event)
    home = SimpleNamespace(cleanup=lambda: None)
    value = {'client': FakeClient(), 'home': home, 'model': model, 'lock': asyncio.Lock(),
             'queue': queue, 'names': {'vibedeck_tool_0': 'read_file'}}
    provider.contexts[id(value)] = value
    return value


@pytest.mark.asyncio
async def test_tool_continuation_reuses_turn_and_cleans_up(monkeypatch):
    provider = codex_provider.CodexProvider()
    value = context(provider, [
        {'method': 'thread/tokenUsage/updated', 'params': {'tokenUsage': {'last': {'inputTokens': 10, 'outputTokens': 2}}}},
        {'method': 'vibedeck/tool', 'params': {'id': 4, 'params': {'tool': 'vibedeck_tool_0', 'arguments': {'path': 'x'}}}},
        {'method': 'item/agentMessage/delta', 'params': {'delta': 'OK'}},
        {'method': 'turn/completed', 'params': {'turn': {'status': 'completed'}}},
    ])
    created = []
    async def create(body):
        created.append(body)
        return value
    monkeypatch.setattr(provider, 'new_context', create)
    body = {'model': 'test', 'messages': [{'role': 'user', 'content': 'read x'}]}
    chunks = [chunk async for chunk in provider.chunks(body)]
    call = chunks[0]['delta']['tool_calls'][0]
    assert call['function']['name'] == 'read_file'
    assert chunks[-1]['usage']['prompt_tokens'] == 10
    assert not value['client'].closed
    # Old tool messages in history must not be replayed into the current turn.
    body['messages'].extend([{'role': 'tool', 'tool_call_id': 'old', 'content': 'old'},
                             {'role': 'assistant', 'content': None},
                             {'role': 'tool', 'tool_call_id': call['id'], 'content': 'file contents'}])
    chunks = [chunk async for chunk in provider.chunks(body)]
    assert len(created) == 1 and chunks[0]['delta']['content'] == 'OK'
    assert value['client'].sent[0]['id'] == 4
    assert value['client'].closed and not provider.pending and not provider.contexts


@pytest.mark.asyncio
async def test_expired_results_never_start_a_paid_turn(monkeypatch):
    provider = codex_provider.CodexProvider()
    async def forbidden(body):
        pytest.fail('Expired tool output must never start a new model turn')
    monkeypatch.setattr(provider, 'new_context', forbidden)
    with pytest.raises(BridgeError, match='expired'):
        _ = [chunk async for chunk in provider.chunks({'model': 'test', 'messages': [
            {'role': 'tool', 'tool_call_id': 'expired', 'content': 'result'}]})]


@pytest.mark.asyncio
async def test_wrong_model_does_not_destroy_another_pending_turn():
    provider = codex_provider.CodexProvider()
    value = context(provider, [])
    provider.pending['call'] = (value, 1)
    with pytest.raises(BridgeError):
        _ = [chunk async for chunk in provider.chunks({'model': 'other', 'messages': [
            {'role': 'tool', 'tool_call_id': 'call', 'content': 'result'}]})]
    assert not value['client'].closed and 'call' in provider.pending
    await provider.close()
    assert value['client'].closed and not provider.contexts


@pytest.mark.asyncio
async def test_effort_conflict_does_not_consume_or_close_pending_tool_results():
    provider = codex_provider.CodexProvider()
    value = context(provider, [{'method': 'turn/completed', 'params': {'turn': {'status': 'completed'}}}])
    value.update(requested_effort='high', effort='high')
    provider.pending['call'] = (value, 1)
    body = {'model': 'test', 'reasoning_effort': 'low', 'messages': [
        {'role': 'tool', 'tool_call_id': 'call', 'content': 'result'}]}
    with pytest.raises(BridgeError, match='effort'):
        _ = [chunk async for chunk in provider.chunks(body)]
    assert not value['client'].closed and not value['client'].sent and 'call' in provider.pending
    body['reasoning_effort'] = 'high'
    assert [chunk async for chunk in provider.chunks(body)][-1]['finish_reason'] == 'stop'
    assert value['client'].closed


def test_codex_http_auth_and_validation(monkeypatch):
    import providers
    import vibedeck_server as server
    from fastapi.testclient import TestClient
    monkeypatch.setattr(providers, 'provider_key', lambda name: 'local-test-token')
    client = TestClient(server.app, base_url="http://127.0.0.1:9377")
    assert client.post('/api/codex/v1/chat/completions', json={}).status_code == 401
    headers = {'Authorization': 'Bearer local-test-token'}
    for bad in ({}, {'model': 'test', 'messages': [{'role': 'user', 'content': []}], 'stream': True},
                {'model': 'test', 'messages': [{'role': 'user', 'content': 'hi'}], 'stream': True, 'tools': ['bad']}):
        assert client.post('/api/codex/v1/chat/completions', headers=headers, json=bad).status_code == 400
    assert client.post('/api/codex/v1/chat/completions', headers=headers, content='{').status_code == 400
    async def failed(body):
        raise BridgeError('auth', 'private server detail')
        yield
    monkeypatch.setattr(server.codex_provider, 'chunks', failed)
    response = client.post('/api/codex/v1/chat/completions', headers=headers,
        json={'model': 'test', 'messages': [{'role': 'user', 'content': 'hi'}], 'stream': True})
    assert response.status_code == 400 and 'private' not in response.text
