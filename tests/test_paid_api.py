"""Explicit opt-in, live paid API checks; two short requests capped at 8 tokens."""
import asyncio
import json

import mistral_api
import pytest

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("streaming", [False, True])
def test_paid_completion_and_usage(streaming):
    async def run():
        key = mistral_api.resolve_api_key()
        assert key, "Configure a Mistral API key before explicitly running paid tests"
        messages = [{"role": "user", "content": "Reply exactly PONG."}]
        if not streaming:
            result = await mistral_api.completion(key, "ministral-3b-latest", messages, temperature=0, max_tokens=8)
            text = result["choices"][0]["message"]["content"]
            usage = result["usage"]
        else:
            snapshots = []
            text = ""
            finished = False
            async for chunk in mistral_api.chat_stream(key, "ministral-3b-latest", messages,
                                                       temperature=0, max_tokens=8, on_usage=snapshots.append):
                if chunk.strip() == "data: [DONE]":
                    finished = True
                    continue
                data = json.loads(chunk.removeprefix("data: "))
                assert "error" not in data, data.get("error")
                if data.get("stream") == "text":
                    text += data["delta"]
            assert finished and snapshots, "Stream must finish and report usage"
            usage = snapshots[-1]
        assert "PONG" in text
        assert usage["prompt_tokens"] > 0
        assert 0 < usage["completion_tokens"] <= 8

    asyncio.run(run())
