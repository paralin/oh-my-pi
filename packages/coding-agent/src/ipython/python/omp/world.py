"""Authority-checked native World operations."""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request

Stop = Literal["current", "custody", "terminal"]


async def dispatch_submit(
    objective: str,
    worktree_path: str,
    working_directory: str,
    worktree_identity: str,
    deliverable_paths: list[str],
    write_surfaces: list[str],
    *,
    done_criteria: str | None = None,
    adapter_argv: list[str] | None = None,
    max_runtime_seconds: float | None = None,
    model: str | None = None,
    owner_artifact: str | None = None,
    repository: str | None = None,
    checkout_identity: str | None = None,
    child_operations: list[str] | None = None,
    request_id: str | None = None,
) -> dict[str, Any]:
    """Submit one idempotent dispatch through the caller's World authority."""
    payload: dict[str, Any] = {
        "objective": objective,
        "worktree_path": worktree_path,
        "working_directory": working_directory,
        "worktree_identity": worktree_identity,
        "deliverable_paths": deliverable_paths,
        "write_surfaces": write_surfaces,
    }
    for name, value in (
        ("done_criteria", done_criteria),
        ("adapter_argv", adapter_argv),
        ("max_runtime_seconds", max_runtime_seconds),
        ("model", model),
        ("owner_artifact", owner_artifact),
        ("repository", repository),
        ("checkout_identity", checkout_identity),
        ("child_operations", child_operations),
        ("request_id", request_id),
    ):
        if value is not None:
            payload[name] = value
    return await host_request("world.dispatch_submit", payload)


async def dispatch_watch(intent_key: str, *, stop: Stop = "terminal") -> dict[str, Any]:
    """Watch one dispatch until the selected bounded condition is met."""
    return await host_request(
        "world.dispatch_watch", {"intent_key": intent_key, "stop": stop}
    )


async def question_answer(
    request_id: str, question: str, summary: str
) -> dict[str, Any]:
    """Record one idempotent answer on a World Question."""
    return await host_request(
        "world.question_answer",
        {"request_id": request_id, "question": question, "summary": summary},
    )


async def session_input(request_id: str, session: str, text: str) -> dict[str, Any]:
    """Deliver steering input to one authority-checked World session."""
    return await host_request(
        "world.session_input",
        {"request_id": request_id, "session": session, "text": text},
    )


async def session_interrupt(
    request_id: str, session: str, *, reason: str | None = None
) -> dict[str, Any]:
    """Store an idempotent cancellation request for one World session."""
    payload: dict[str, Any] = {"request_id": request_id, "session": session}
    if reason is not None:
        payload["reason"] = reason
    return await host_request("world.session_interrupt", payload)


__all__ = [
    "dispatch_submit",
    "dispatch_watch",
    "question_answer",
    "session_input",
    "session_interrupt",
]
