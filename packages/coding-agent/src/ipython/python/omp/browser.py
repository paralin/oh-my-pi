"""Session-private browser tabs exposed through opaque handles."""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request


async def tabs() -> dict[str, Any]:
    """List browser tabs available to this session."""
    return await host_request("browser.tabs", {})


async def open(
    name: str = "main",
    *,
    url: str | None = None,
    viewport: dict[str, int | float] | None = None,
    wait_until: Literal["load", "domcontentloaded", "networkidle0", "networkidle2"]
    | None = None,
    dialogs: Literal["accept", "dismiss"] | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Open or reuse a named browser tab."""
    payload: dict[str, Any] = {"name": name}
    for key, value in (
        ("url", url),
        ("viewport", viewport),
        ("wait_until", wait_until),
        ("dialogs", dialogs),
        ("timeout", timeout),
    ):
        if value is not None:
            payload[key] = value
    return await host_request("browser.open", payload)


async def evaluate(
    handle: str, code: str, *, timeout: float | None = None
) -> dict[str, Any]:
    """Evaluate JavaScript in an admitted browser tab."""
    payload: dict[str, Any] = {"handle": handle, "code": code}
    if timeout is not None:
        payload["timeout"] = timeout
    return await host_request("browser.evaluate", payload)


async def release(
    handle: str | None = None,
    *,
    all: bool = False,
    kill: bool = False,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Release one admitted tab or every tab in this session."""
    if bool(handle) == all:
        raise ValueError("release requires exactly one nonempty handle or all=True")
    payload: dict[str, Any] = {"all": all, "kill": kill}
    if handle is not None:
        payload["handle"] = handle
    if timeout is not None:
        payload["timeout"] = timeout
    return await host_request("browser.release", payload)


__all__ = ["evaluate", "open", "release", "tabs"]
