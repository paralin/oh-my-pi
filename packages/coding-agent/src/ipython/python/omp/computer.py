"""Session-private desktop control through a host-owned worker."""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def capabilities() -> dict[str, Any]:
    """Return desktop capabilities and permission state."""
    return await host_request("computer.capabilities", {})


async def evaluate(
    code: str,
    *,
    read_only: bool = False,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Evaluate code in the isolated desktop worker."""
    payload: dict[str, Any] = {"code": code, "read_only": read_only}
    if timeout is not None:
        payload["timeout"] = timeout
    return await host_request("computer.evaluate", payload)


async def release() -> dict[str, Any]:
    """Release the desktop worker."""
    return await host_request("computer.release", {})


__all__ = ["capabilities", "evaluate", "release"]
