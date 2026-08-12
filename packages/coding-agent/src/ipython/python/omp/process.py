"""One-shot argv execution and project-scoped retained process supervision."""

from __future__ import annotations

import builtins
from typing import Any, Literal, Mapping, Sequence, TypeAlias

from rlm import host_request

RestartPolicy = Literal["no", "on-failure", "always"]
WaitTarget = Literal["ready", "exit"]
ProcessSignal = Literal["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL"]
Timeout: TypeAlias = float | str


async def run(
    application: str,
    args: Sequence[str] = (),
    *,
    timeout: Timeout | None = None,
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Run one argv command under active-cell process custody.

    Numeric timeouts are seconds; duration strings accept ``ms``, ``s``, ``m``,
    or ``h`` suffixes. OMP bounds independent stdout and stderr head/tail windows and writes
    the complete transcript to a runtime-managed artifact. Callers cannot select
    the artifact path. Relative ``cwd`` paths stay inside the active project.
    """
    payload: dict[str, object] = {"application": application, "args": builtins.list(args)}
    if timeout is not None:
        payload["timeout"] = timeout
    if cwd is not None:
        payload["cwd"] = cwd
    if env is not None:
        payload["env"] = dict(env)
    return await host_request("process.run", payload)


async def start(
    name: str,
    application: str,
    args: Sequence[str] = (),
    *,
    env: Mapping[str, str] | None = None,
    cwd: str | None = None,
    pty: bool = True,
    ready: Mapping[str, object] | None = None,
    restart: RestartPolicy = "no",
    persist: bool = False,
    detached: bool = False,
) -> dict[str, Any]:
    """Start a project-scoped long-lived process retained by OMP's launch broker.

    ``persist`` keeps the broker record across ordinary client exits. ``detached``
    also keeps the child alive across broker restarts, implies persistence, and
    disables PTY input. Relative ``cwd`` paths stay inside the active project.
    """
    payload: dict[str, object] = {
        "name": name,
        "application": application,
        "args": builtins.list(args),
        "pty": pty,
        "restart": restart,
        "persist": persist,
        "detached": detached,
    }
    if env is not None:
        payload["env"] = dict(env)
    if cwd is not None:
        payload["cwd"] = cwd
    if ready is not None:
        payload["ready"] = dict(ready)
    return await host_request("process.start", payload)


async def list() -> dict[str, Any]:
    """List active and bounded recent project-scoped broker process snapshots."""
    return await host_request("process.list", {})


async def describe(name: str) -> dict[str, Any]:
    """Return one process snapshot and its retained immutable launch specification."""
    return await host_request("process.describe", {"name": name})


async def logs(
    name: str,
    *,
    lines: int = 100,
    head: bool = False,
    grep: str | None = None,
    follow: bool = False,
    cursor: int | None = None,
    timeout_ms: int = 30_000,
) -> dict[str, Any]:
    """Read process logs, optionally waiting for bytes newer than a prior cursor."""
    payload: dict[str, object] = {
        "name": name,
        "lines": lines,
        "head": head,
        "follow": follow,
        "timeout_ms": timeout_ms,
    }
    if grep is not None:
        payload["grep"] = grep
    if cursor is not None:
        payload["cursor"] = cursor
    return await host_request("process.logs", payload)


async def wait(
    name: str,
    *,
    for_: WaitTarget = "exit",
    pattern: str | None = None,
    timeout_ms: int = 30_000,
) -> dict[str, Any]:
    """Wait event-first for readiness, exit, or a retained process-log pattern."""
    payload: dict[str, object] = {"name": name, "for": for_, "timeout_ms": timeout_ms}
    if pattern is not None:
        payload["pattern"] = pattern
    return await host_request("process.wait", payload)


async def send(
    name: str,
    data: str | None = None,
    *,
    signal: ProcessSignal | None = None,
) -> dict[str, Any]:
    """Write stdin bytes and/or send one signal to a retained process tree."""
    payload: dict[str, object] = {"name": name}
    if data is not None:
        payload["data"] = data
    if signal is not None:
        payload["signal"] = signal
    return await host_request("process.send", payload)


async def stop(name: str, *, timeout_ms: int = 5_000) -> dict[str, Any]:
    """Stop one process tree and wait up to ``timeout_ms`` for terminal state."""
    return await host_request("process.stop", {"name": name, "timeout_ms": timeout_ms})


async def restart(name: str) -> dict[str, Any]:
    """Restart one process from its retained immutable launch specification."""
    return await host_request("process.restart", {"name": name})


__all__ = ["describe", "list", "logs", "restart", "run", "send", "start", "stop", "wait"]
