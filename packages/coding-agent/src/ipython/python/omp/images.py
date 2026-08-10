"""Image generation and attachment metadata for the active OMP session."""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def attachments() -> dict[str, Any]:
    """Return bounded metadata for the session's image attachments."""
    return await host_request("images.attachments", {})


async def generate(
    subject: str,
    *,
    action: str | None = None,
    scene: str | None = None,
    composition: str | None = None,
    lighting: str | None = None,
    style: str | None = None,
    text: str | None = None,
    changes: list[str] | None = None,
    aspect_ratio: str | None = None,
    image_size: str | None = None,
    input_paths: list[str] | None = None,
    provider: str | None = None,
) -> dict[str, Any]:
    """Generate images from a bounded prompt and optional path-based inputs."""
    payload: dict[str, Any] = {"subject": subject}
    for name, value in (
        ("action", action),
        ("scene", scene),
        ("composition", composition),
        ("lighting", lighting),
        ("style", style),
        ("text", text),
        ("changes", changes),
        ("aspect_ratio", aspect_ratio),
        ("image_size", image_size),
        ("input_paths", input_paths),
        ("provider", provider),
    ):
        if value is not None:
            payload[name] = value
    return await host_request("images.generate", payload)


__all__ = ["attachments", "generate"]
