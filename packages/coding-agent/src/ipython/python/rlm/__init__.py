"""Callable RLM admission and typed host bridge for OMP's IPython runtime."""

from __future__ import annotations

import asyncio
import sys
import threading
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .harness import HarnessEntry, HarnessScope, HarnessState, RefinementEvent, get_harness_state

try:
    from ipykernel.comm import Comm
except Exception:  # pragma: no cover
    Comm = None  # type: ignore[assignment]

try:
    from IPython import get_ipython
except Exception:  # pragma: no cover
    get_ipython = None  # type: ignore[assignment]

HOST_COMM_TARGET = "host.request"


@dataclass(frozen=True)
class RLMSpawnHandle:
    rlm_child_id: str
    name: str
    session_dir: Path
    model: str


@dataclass(frozen=True)
class RLMModel:
    provider: str
    id: str
    name: str
    selector: str


@dataclass(frozen=True)
class RLMSubagent:
    rlm_child_id: str
    active_session_id: str | None
    session_id: str | None
    session_name: str
    session_dir: Path
    status: str


def _install_control_comm_handlers() -> None:
    if get_ipython is None:
        return
    shell = get_ipython()
    kernel = getattr(shell, "kernel", None)
    comm_manager = getattr(kernel, "comm_manager", None)
    control_handlers = getattr(kernel, "control_handlers", None)
    if comm_manager is None or not isinstance(control_handlers, dict):
        return
    control_handlers.setdefault("comm_msg", comm_manager.comm_msg)
    control_handlers.setdefault("comm_close", comm_manager.comm_close)


def _validate_request(request_type: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(request_type, str) or not request_type.strip():
        raise TypeError("request_type must be a non-empty str")
    if payload is not None and not isinstance(payload, dict):
        raise TypeError(f"payload must be a dict or None, got {type(payload).__name__}")
    if Comm is None:
        raise RuntimeError("Jupyter comm support is unavailable in this kernel")
    return {**(payload or {}), "type": request_type}


def _reply(msg: dict[str, Any], request_type: str) -> tuple[dict[str, Any] | None, RuntimeError | None]:
    content = msg.get("content", {})
    value = content.get("data", {}) if isinstance(content, dict) else {}
    if not isinstance(value, dict):
        return None, RuntimeError(f"host request {request_type} returned an invalid reply")
    status = value.get("status")
    if status == "ok":
        return {key: item for key, item in value.items() if key != "status"}, None
    if status == "error":
        return None, RuntimeError(str(value.get("error") or f"host request {request_type} failed"))
    return None, RuntimeError(f"host request {request_type} returned unexpected status: {status!r}")


async def host_request(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Send one typed cancellable request to the active OMP cell host."""
    data = _validate_request(request_type, payload)
    _install_control_comm_handlers()
    loop = asyncio.get_running_loop()
    future: asyncio.Future[dict[str, Any]] = loop.create_future()
    comm = Comm(target_name=HOST_COMM_TARGET, primary=False)

    def on_msg(msg: dict[str, Any]) -> None:
        result, error = _reply(msg, request_type)

        def settle() -> None:
            if future.done():
                return
            if error is not None:
                future.set_exception(error)
            else:
                future.set_result(result or {})
            comm.close()

        loop.call_soon_threadsafe(settle)

    comm.on_msg(on_msg)
    comm.open(data=data)
    try:
        return await future
    finally:
        if not future.done():
            comm.close()


def host_request_sync(request_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Synchronous host request used by the Prime-compatible harness CRUD API."""
    data = _validate_request(request_type, payload)
    _install_control_comm_handlers()
    finished = threading.Event()
    outcome: dict[str, Any] = {}
    comm = Comm(target_name=HOST_COMM_TARGET, primary=False)

    def on_msg(msg: dict[str, Any]) -> None:
        result, error = _reply(msg, request_type)
        outcome["result"] = result
        outcome["error"] = error
        finished.set()

    comm.on_msg(on_msg)
    comm.open(data=data)
    try:
        finished.wait()
    finally:
        comm.close()
    error = outcome.get("error")
    if isinstance(error, BaseException):
        raise error
    result = outcome.get("result")
    if not isinstance(result, dict):
        raise RuntimeError(f"host request {request_type} returned no reply")
    return result


def _spawn_handle(payload: Any) -> RLMSpawnHandle:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    values = [payload.get(key) for key in ("rlm_child_id", "name", "session_dir", "model")]
    if not all(isinstance(value, str) and value for value in values):
        raise RuntimeError("rlm.run returned an invalid spawn handle")
    return RLMSpawnHandle(values[0], values[1], Path(values[2]), values[3])  # type: ignore[arg-type]


async def run(prompt: str, **kwargs: Any) -> RLMSpawnHandle:
    """Admit one OMP Task child and return immediately with its RLM handle."""
    if not isinstance(prompt, str):
        raise TypeError(f"prompt must be str, got {type(prompt).__name__}")
    return _spawn_handle(await host_request("rlm.run", {"prompt": prompt, "kwargs": kwargs}))


def _model(payload: Any) -> RLMModel:
    if not isinstance(payload, dict):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    values = [payload.get(key) for key in ("provider", "id", "name", "selector")]
    if not all(isinstance(value, str) and value for value in values):
        raise RuntimeError("rlm.find_models returned an invalid model entry")
    return RLMModel(*values)  # type: ignore[arg-type]


async def find_models(query: str = "", limit: int = 8) -> list[RLMModel]:
    """Search a bounded list of models available to the active OMP session."""
    if not isinstance(query, str):
        raise TypeError(f"query must be str, got {type(query).__name__}")
    if not isinstance(limit, int) or isinstance(limit, bool):
        raise TypeError(f"limit must be int, got {type(limit).__name__}")
    payload = await host_request("rlm.find_models", {"query": query, "limit": limit})
    models = payload.get("models")
    if not isinstance(models, list):
        raise RuntimeError("rlm.find_models returned an invalid models list")
    return [_model(item) for item in models]


def _subagent(payload: Any, operation: str) -> RLMSubagent:
    if not isinstance(payload, dict):
        raise RuntimeError(f"{operation} returned an invalid subagent entry")
    child_id = payload.get("rlm_child_id")
    session_name = payload.get("session_name")
    session_dir = payload.get("session_dir")
    status = payload.get("status")
    if not all(isinstance(item, str) and item for item in (child_id, session_name, session_dir, status)):
        raise RuntimeError(f"{operation} returned an invalid subagent entry")
    for key in ("active_session_id", "session_id"):
        if payload.get(key) is not None and not isinstance(payload[key], str):
            raise RuntimeError(f"{operation} returned an invalid subagent entry")
    return RLMSubagent(child_id, payload.get("active_session_id"), payload.get("session_id"),
                       session_name, Path(session_dir), status)


async def list_subagents() -> list[RLMSubagent]:
    """List direct Task children retained by the active parent session."""
    payload = await host_request("rlm.list_subagents")
    values = payload.get("subagents")
    if not isinstance(values, list):
        raise RuntimeError("rlm.list_subagents returned an invalid registry")
    return [_subagent(value, "rlm.list_subagents") for value in values]


async def delete_subagent(target: str | RLMSubagent) -> RLMSubagent:
    """Delete one running or retained direct Task child."""
    selector = target.rlm_child_id if isinstance(target, RLMSubagent) else target
    if not isinstance(selector, str) or not selector.strip():
        raise ValueError("target must be a non-empty str or RLMSubagent")
    payload = await host_request("rlm.delete_subagent", {"target": selector.strip()})
    return _subagent(payload.get("subagent"), "rlm.delete_subagent")


class _HarnessProxy:
    def __getattr__(self, name: str) -> Any:
        return getattr(get_harness_state(), name)

    def __repr__(self) -> str:
        return "OMP host-backed HarnessState(local)"


harness = _HarnessProxy()


class _RLMCallable:
    harness = harness
    get_harness_state = staticmethod(get_harness_state)

    async def run(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)

    async def find_models(self, query: str = "", limit: int = 8) -> list[RLMModel]:
        return await find_models(query, limit)

    async def list_subagents(self) -> list[RLMSubagent]:
        return await list_subagents()

    async def delete_subagent(self, target: str | RLMSubagent) -> RLMSubagent:
        return await delete_subagent(target)

    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


rlm = _RLMCallable()


class _CallableModule(types.ModuleType):
    async def __call__(self, prompt: str, **kwargs: Any) -> RLMSpawnHandle:
        return await run(prompt, **kwargs)


sys.modules[__name__].__class__ = _CallableModule

__all__ = [
    "HarnessEntry", "HarnessScope", "HarnessState", "McpIntegration", "McpToolError", "NotEnabled",
    "RLMModel", "RLMSpawnHandle", "RLMSubagent", "RefinementEvent", "delete_subagent", "find_models",
    "get_harness_state", "harness", "host_request", "host_request_sync", "list_subagents", "rlm", "run",
]

_LAZY_MCP = {"McpIntegration", "McpToolError", "NotEnabled"}


def __getattr__(name: str) -> Any:
    if name in _LAZY_MCP:
        from . import mcp_base
        return getattr(mcp_base, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
