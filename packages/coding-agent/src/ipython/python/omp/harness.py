"""OMP session controls that remain authoritative in the host."""

from __future__ import annotations

from typing import Any

from rlm import harness, host_request


async def checkpoint(label: str | None = None) -> dict[str, Any]:
    """Create a conversation and named-kernel checkpoint."""
    return await host_request("checkpoint.create", {"label": label})


async def checkpoint_status() -> dict[str, Any]:
    """Read whether a checkpoint or deferred rewind is active."""
    return await host_request("checkpoint.status")


async def rewind(report: str) -> dict[str, Any]:
    """Schedule restoration of the active conversation and kernel checkpoint.

    The host replies before replacing the active kernel. The rewind runs after
    the current cell and model turn finish, retains ``report`` in the rewound
    branch, and resumes the agent from that report.
    """
    if not isinstance(report, str):
        raise TypeError(f"report must be str, got {type(report).__name__}")
    return await host_request("checkpoint.rewind", {"report": report})


async def todo(operation: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Apply one typed operation to the active session todo tracker."""
    return await host_request("todo.apply", {"operation": operation, "payload": payload or {}})


async def rules() -> dict[str, Any]:
    """List the active OMP rule records."""
    return await host_request("rules.list")


async def skills() -> dict[str, Any]:
    """List the active OMP skill records and Python metadata."""
    return await host_request("skills.list")


__all__ = ["checkpoint", "checkpoint_status", "harness", "rewind", "rules", "skills", "todo"]
