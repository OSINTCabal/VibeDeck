"""What a user message becomes on the wire: content blocks for ``turn/start``
and turn-queue entries, with the inline images VibeDeck accepts."""
from __future__ import annotations

import base64
import binascii
from typing import Optional

IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")
MAX_IMAGES = 8
MAX_IMAGE_BYTES = 10 * 1024 * 1024


def validate_images(images: list[dict]) -> None:
    """Raise ``ValueError`` with a user-facing message for unusable images."""
    if len(images) > MAX_IMAGES:
        raise ValueError(f"attach up to {MAX_IMAGES} images")
    for image in images:
        source = image.get("source") or {}
        if not isinstance(source, dict):
            raise ValueError("image source must be an inline image object")
        data = source.get("data")
        if (source.get("kind") != "inline" or image.get("mimeType") not in IMAGE_TYPES
                or not isinstance(data, str) or len(data) > 14 * 1024 * 1024):
            raise ValueError("images must be PNG, JPEG, WebP or GIF up to 10 MB")
        try:
            if len(base64.b64decode(data, validate=True)) > MAX_IMAGE_BYTES:
                raise ValueError("too large")
        except (ValueError, binascii.Error):
            raise ValueError("invalid image data") from None


def message_blocks(text: str, images: Optional[list[dict]] = None) -> list[dict]:
    blocks: list[dict] = [{"type": "text", "text": text}]
    blocks.extend({"type": "image", "attachment": img} for img in images or [])
    return blocks


def user_entry(text: str, images: Optional[list[dict]] = None, entry_id: Optional[str] = None) -> dict:
    """A queued user message. ``entry_id`` becomes the history entry's id, which
    is what ``session/rewind`` looks the message up by."""
    entry: dict = {"role": "user", "content": message_blocks(text, images)}
    if entry_id:
        entry["entryId"] = entry_id
    return entry
