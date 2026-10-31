"""Dictation for the composer.

Vibe's own voice input (``voice/*``) lives in ``vibe-acp`` and records from
the machine's microphone on the server side, so it does not fit a desktop
app. The renderer records instead and sends the clip here; the sidecar
transcribes it with Mistral's Voxtral through the user's API key.
"""
from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from mistral_api import MISTRAL_BASE, resolve_api_key

router = APIRouter()

MODEL = "voxtral-mini-latest"
MAX_BYTES = 25 * 1024 * 1024
# languages Voxtral transcription accepts as a hint; others are auto-detected
LANGUAGES = {"ar", "en", "de", "es", "fr", "hi", "it", "nl", "pt", "zh", "ru", "ko", "ja"}
AUDIO_TYPES = ("audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/m4a")


@router.post("/api/voice/transcribe")
async def transcribe(request: Request, language: str = Query("", max_length=16)) -> dict:
    """The request body is the recording itself, typed by its Content-Type."""
    key = resolve_api_key()
    if not key:
        raise HTTPException(400, "Add a Mistral API key in Settings to use dictation.")
    content_type = (request.headers.get("content-type") or "").split(";")[0].strip()
    if content_type not in AUDIO_TYPES:
        raise HTTPException(400, f"Unsupported audio type: {content_type or 'unknown'}")
    data = b""
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_BYTES:
            break
    if not data:
        raise HTTPException(400, "The recording is empty")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "The recording is longer than dictation allows")
    form = {"model": MODEL}
    hint = language.split("-")[0].lower()
    if hint in LANGUAGES:
        form["language"] = hint
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(f"{MISTRAL_BASE}/audio/transcriptions",
                                     headers={"Authorization": f"Bearer {key}"},
                                     data=form, files={"file": ("dictation." + content_type.split("/")[1].replace("x-", ""), data, content_type)})
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Could not reach Mistral: {e.__class__.__name__}") from e
    if resp.status_code in (401, 403):
        raise HTTPException(400, "This Mistral API key cannot use transcription. Use a key with access to Voxtral.")
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("message")
        except ValueError:
            detail = None
        raise HTTPException(502, f"Transcription failed: {detail or resp.status_code}")
    return {"text": (resp.json().get("text") or "").strip()}
