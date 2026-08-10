"""Typed, task-backed Vibe worker sessions."""

from __future__ import annotations

from typing import Literal

from rlm import host_request


async def spawn(cli: Literal["fast", "good"], prompt: str, *, name: str | None = None) -> dict[str, object]:
    """Start one addressable Vibe worker turn on the selected model tier."""
    payload: dict[str, object] = {"cli": cli, "prompt": prompt}
    if name is not None:
        payload["name"] = name
    return await host_request("vibe.spawn", payload)


async def send(session: str, message: str) -> dict[str, object]:
    """Steer a live Vibe turn or schedule its next addressable turn."""
    return await host_request("vibe.send", {"session": session, "message": message})


async def wait(
    sessions: list[str] | None = None, *, timeout_seconds: float | None = None
) -> dict[str, object]:
    """Wait for the first selected Vibe turn to settle or the timeout to elapse."""
    payload: dict[str, object] = {}
    if sessions is not None:
        payload["sessions"] = sessions
    if timeout_seconds is not None:
        payload["timeout_seconds"] = timeout_seconds
    return await host_request("vibe.wait", payload)


async def kill(session: str) -> dict[str, object]:
    """Terminate one Vibe worker and its active turn, retaining its transcript."""
    return await host_request("vibe.kill", {"session": session})


async def list() -> dict[str, object]:
    """List bounded snapshots for this session's Vibe workers."""
    return await host_request("vibe.list", {})


__all__ = ["kill", "list", "send", "spawn", "wait"]
