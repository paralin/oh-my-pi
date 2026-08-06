"""Active OMP IPython cell services."""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def info() -> dict[str, Any]:
    """Return bounded active session and cell identity without credentials."""
    return await host_request("session.info")


async def progress(message: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    """Publish progress into the current IPython cell update."""
    return await host_request("cell.progress", {"message": message, "data": data or {}})


async def allocate_artifact(label: str, *, mime_type: str = "application/octet-stream", suffix: str = "") -> dict[str, Any]:
    """Allocate one host-owned artifact path for the active cell."""
    return await host_request("artifact.allocate", {"label": label, "mimeType": mime_type, "suffix": suffix})
