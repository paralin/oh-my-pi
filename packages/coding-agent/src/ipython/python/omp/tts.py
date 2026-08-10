"""Host-owned local and xAI speech-file synthesis."""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request

TtsBackend = Literal["local", "xai"]


async def synthesize(
    text: str,
    output_path: str,
    *,
    backend: TtsBackend = "local",
    voice_id: str | None = None,
    language: str | None = None,
    sample_rate: int | None = None,
    bit_rate: int | None = None,
) -> dict[str, Any]:
    """Write bounded speech audio beneath the active project without exposing credentials.

    ``local`` uses the active session's configured Kokoro model and voice and
    always writes PCM16 WAV. ``xai`` resolves the active session's xAI
    credentials in the host and can write WAV or MP3. Local MP3 requests write
    a sibling WAV path because OMP ships no local MP3 encoder.
    """
    payload: dict[str, object] = {
        "text": text,
        "output_path": output_path,
        "backend": backend,
    }
    for name, value in (
        ("voice_id", voice_id),
        ("language", language),
        ("sample_rate", sample_rate),
        ("bit_rate", bit_rate),
    ):
        if value is not None:
            payload[name] = value
    return await host_request("tts.synthesize", payload)


__all__ = ["synthesize"]
