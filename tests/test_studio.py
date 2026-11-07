"""Studio generation controls reach Mistral; no paid network requests."""
from contextlib import asynccontextmanager

import httpx
import mistral_api
import pytest
import vibedeck_server as server
from fastapi.testclient import TestClient


@pytest.mark.parametrize("stream", [True, False])
@pytest.mark.asyncio
async def test_studio_parameters_reach_mistral(monkeypatch, stream):
    bodies = []

    class Response:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": "{}"}}]}

        async def aiter_lines(self):
            yield 'data: {"choices":[{"delta":{"content":"{}"}}]}'
            yield "data: [DONE]"

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        @asynccontextmanager
        async def stream(self, method, url, **kwargs):
            assert method == "POST" and url == mistral_api.MISTRAL_BASE + "/chat/completions"
            bodies.append(kwargs["json"])
            yield Response()

        async def post(self, url, **kwargs):
            assert url == mistral_api.MISTRAL_BASE + "/chat/completions"
            bodies.append(kwargs["json"])
            return Response()

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: Client())
    options = {"top_p": .8, "random_seed": 17, "presence_penalty": .2, "frequency_penalty": .4,
               "stop": ["END"], "json_mode": True, "safe_prompt": True}
    messages = [{"role": "user", "content": "Say hello"}]
    if stream:
        chunks = [chunk async for chunk in mistral_api.chat_stream("fixture", "mistral-large-4", messages,
                  temperature=0, max_tokens=16, generation=options)]
        assert chunks[-1] == "data: [DONE]\n\n"
    else:
        await mistral_api.completion("fixture", "mistral-large-4", messages,
                                    temperature=0, max_tokens=16, generation=options)
    body = bodies[0]
    assert body["top_p"] == 1, "Greedy sampling overrides Top P"
    assert body["max_tokens"] == 16 and body["stream"] is stream
    assert body["response_format"] == {"type": "json_object"}
    assert body["messages"][0]["content"] == "Respond with a valid JSON object."
    assert messages == [{"role": "user", "content": "Say hello"}], "Do not mutate history"
    for field in ("random_seed", "presence_penalty", "frequency_penalty", "stop", "safe_prompt"):
        assert body[field] == options[field]


def test_studio_routes_forward_options_and_reject_invalid_before_request(monkeypatch):
    calls = []
    monkeypatch.setattr(server, "_require_key", lambda: "fixture")

    async def complete(*args, **kwargs):
        calls.append(kwargs["generation"])
        return {"choices": []}

    async def stream(*args, **kwargs):
        calls.append(kwargs["generation"])
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(server, "completion", complete)
    monkeypatch.setattr(server, "chat_stream", stream)
    options = {"top_p": .75, "random_seed": 23, "presence_penalty": .5, "frequency_penalty": .3,
               "stop": ["END"], "json_mode": True, "safe_prompt": True}
    with TestClient(server.app, base_url="http://127.0.0.1:9377") as client:
        for route, base in [("/api/chat", {"message": "Hello"}),
                            ("/api/studio/completions", {"messages": [{"role": "user", "content": "Hello"}]})]:
            assert client.post(route, json={**base, **options}).status_code == 200
            assert calls[-1] == options
            for bad in [{"top_p": 0}, {"top_p": 1.1}, {"random_seed": -1}, {"random_seed": 1.1},
                        {"frequency_penalty": 3}, {"presence_penalty": -3}, {"max_tokens": 0},
                        {"stop": ["a"] * 9}, {"temperature": 3}]:
                assert client.post(route, json={**base, **bad}).status_code == 422
    assert len(calls) == 2, "Invalid controls must not spend tokens"
